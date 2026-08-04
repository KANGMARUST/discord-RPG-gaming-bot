import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
} from 'discord.js';
import {
  calculateTotalStats,
  createEquipment,
  equipmentSlots,
  formatEquipmentName,
  getEquipmentName,
  rollEquipmentRarity,
  shouldDropEquipmentFromMonster,
} from './equipment.js';
import { getPotion, rollPotionDrop } from './items.js';
import { LEVEL_STAT_GROWTH } from './leveling.js';
import {
  calculateSkillAttackPower,
  calculateSkillHealing,
  getSkill,
  rollSkillFragment,
} from './skills.js';
import { createMonsterSkillSet, getDungeonRegion } from './monster-catalog.js';
import { dungeonLogger } from './dungeon-logger.js';
import { roundHealth } from './adventure-manager.js';
import { getCheckpointFloorAfterBoss, getUnlockedCheckpointFloors } from './checkpoints.js';

const TURN_SEPARATOR = '# ============================================================';
const BATTLE_ACTION_DELAY_MS = 1_000;
const RESOURCE_BAR_SEGMENTS = 10;
const HEALTH_BAR_FILLED = '🟥';
const MANA_BAR_FILLED = '🟦';
const RESOURCE_BAR_EMPTY = '⬛';
const roundMana = (value) => Math.round(value * 10) / 10;
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const monsterAssetsDirectory = path.join(currentDirectory, '..', 'assets', 'monsters');
const eventAssetsDirectory = path.join(currentDirectory, '..', 'assets', 'events');
const MONSTER_IMAGE_FILES = {
  슬라임: 'slime.png',
  고블린: 'goblin.png',
  '해골 병사': 'skeleton-soldier.png',
  '오크 전사': 'orc-warrior.png',
  '던전 수호자': 'dungeon-guardian.png',
  미믹: 'mimic.png',
};

export function rollExplorationEvent(
  includeStairs = true,
  bossPending = false,
  random = Math.random,
  stairsChance = 0.2,
) {
  if (typeof bossPending === 'function') {
    random = bossPending;
    bossPending = false;
  }
  const roll = random();
  if (bossPending) {
    if (roll < 0.3) return 'BOSS';
    if (roll < 0.5) return 'SPECIAL';
    return 'ENEMY';
  }
  if (includeStairs) {
    const normalizedStairsChance = Math.min(0.65, Math.max(0, stairsChance));
    if (roll < normalizedStairsChance) return 'STAIRS';
    if (roll < normalizedStairsChance + 0.2) return 'SPECIAL';
    return 'ENEMY';
  }
  return roll < 0.3 ? 'SPECIAL' : 'ENEMY';
}

export function rollSpecialEvent(random = Math.random) {
  const roll = random();
  if (roll < 0.5) return 'TREASURE';
  if (roll < 0.8) return 'TRAP';
  return 'REST';
}

class AdventureSystem {
  constructor(client, adventureManager, playerStore) {
    this.client = client;
    this.adventureManager = adventureManager;
    this.playerStore = playerStore;
    this.battles = new Map();
  }

  getTextChannel(adventure) {
    return this.client.guilds.cache
      .get(adventure.guildId)
      ?.channels.cache.get(adventure.textChannelId);
  }

  createPlayerTurnEmbed(adventure, userId) {
    const member = this.client.guilds.cache
      .get(adventure.guildId)
      ?.members.cache.get(userId);
    const displayName = member?.displayName ?? '플레이어';
    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(`🟢 ${displayName}님의 턴`)
      .setDescription('현재 행동할 플레이어입니다.');
    if (member) embed.setThumbnail(member.user.displayAvatarURL({ size: 256 }));
    return embed;
  }

  createMonsterTurnVisual(monster, skill) {
    const imageFile = monster.imageFile
      ?? MONSTER_IMAGE_FILES[monster.name]
      ?? MONSTER_IMAGE_FILES['던전 수호자'];
    const attachmentName = `monster-${monster.level}.png`;
    const attachment = new AttachmentBuilder(path.join(monsterAssetsDirectory, imageFile), {
      name: attachmentName,
    });
    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle(`🔴 Lv.${monster.level} ${monster.name}의 턴`)
      .setDescription(`「${skill.name}」을(를) 시전합니다.`)
      .setThumbnail(`attachment://${attachmentName}`);
    return { embed, attachment };
  }

  createMonsterBattleVisual(monster, adventure, userId) {
    const imageFile = monster.imageFile
      ?? MONSTER_IMAGE_FILES[monster.name]
      ?? MONSTER_IMAGE_FILES['던전 수호자'];
    const attachmentName = `battle-monster-${monster.level}.png`;
    const attachment = new AttachmentBuilder(path.join(monsterAssetsDirectory, imageFile), {
      name: attachmentName,
    });
    const member = this.client.guilds.cache.get(adventure.guildId)?.members.cache.get(userId);
    const embed = new EmbedBuilder()
      .setColor(monster.isBoss ? 0x9b111e : 0xe67e22)
      .setTitle(`🟢 ${member?.displayName ?? '플레이어'}님의 턴`)
      .setDescription(`👾 **Lv.${monster.level} ${monster.name}** · ❤️ ${monster.health}/${monster.maxHealth}\n📍 ${monster.regionName}`)
      .setThumbnail(`attachment://${attachmentName}`);
    if (member) {
      embed.setAuthor({
        name: '현재 행동할 플레이어',
        iconURL: member.user.displayAvatarURL({ size: 128 }),
      });
    }
    return { embed, attachment };
  }

  async waitAfterBattleAction() {
    await new Promise((resolve) => setTimeout(resolve, BATTLE_ACTION_DELAY_MS));
  }

  createButtons(adventure, buttons, ownerId = 'any') {
    const token = randomUUID().slice(0, 8);
    adventure.currentActionToken = token;
    return new ActionRowBuilder().addComponents(
      buttons.map(({ action, label, style }) =>
        new ButtonBuilder()
          .setCustomId(`dungeon:${adventure.id}:${token}:${action}:${ownerId}`)
          .setLabel(label)
          .setStyle(style),
      ),
    );
  }

  async start(adventure) {
    adventure.stairsAvailable = false;
    adventure.bossDefeated = false;
    adventure.combatsWonThisFloor = 0;
    adventure.acquiredEquipmentIdsByUser ??= Object.fromEntries(
      adventure.memberIds.map((userId) => [userId, []]),
    );
    adventure.acquiredGoldByUser ??= Object.fromEntries(
      adventure.memberIds.map((userId) => [userId, 0]),
    );
    const players = {};
    adventure.manaByUser ??= {};
    for (const userId of adventure.memberIds) {
      const player = await this.playerStore.getOrCreate(userId);
      const totalStats = calculateTotalStats(player);
      const savedMana = adventure.manaByUser[userId];
      adventure.manaByUser[userId] = roundMana(
        Math.min(totalStats.mana, Math.max(0, savedMana ?? totalStats.mana)),
      );
      players[userId] = {
        playerLevel: player.stats.playerLevel,
        experience: player.experience,
        totalStats,
        equipment: structuredClone(player.equipment),
        equippedSkills: [...player.equippedSkills],
      };
    }
    await dungeonLogger.start(adventure, players);
    const leader = await this.playerStore.getOrCreate(adventure.leaderId);
    adventure.availableCheckpointFloors = getUnlockedCheckpointFloors(leader.checkpointFloor);
    if (adventure.availableCheckpointFloors.length > 1) {
      await this.askToUseCheckpoint(adventure);
      return;
    }
    await this.beginNextStep(adventure);
  }

  isBossFloor(floor) {
    return floor > 0 && floor % 5 === 0;
  }

  async askToUseCheckpoint(adventure) {
    const channel = this.getTextChannel(adventure);
    if (!channel) return;
    const floors = adventure.availableCheckpointFloors ?? [1];
    adventure.currentActionToken = randomUUID();
    const select = new StringSelectMenuBuilder()
      .setCustomId(`checkpoint_select:${adventure.id}:${adventure.currentActionToken}`)
      .setPlaceholder('시작할 체크포인트를 선택하세요')
      .addOptions(floors.map((floor) => ({
        label: `${floor}층에서 시작`,
        value: String(floor),
        description: floor === 1 ? '처음부터 모험을 시작합니다.' : `${floor - 1}층 보스 처치 체크포인트`,
        emoji: floor === 1 ? '🏰' : '🚩',
      })));
    const row = new ActionRowBuilder().addComponents(select);
    await channel.send({
      content: [
        `# 🚩 공대장 <@${adventure.leaderId}>님의 체크포인트`,
        `해금된 시작 층: **${floors.map((floor) => `${floor}층`).join(', ')}**`,
        '공대장이 이번 모험을 시작할 층을 선택해 주세요.',
      ].join('\n'),
      components: [row],
    });
  }

  async beginNextStep(adventure) {
    if (!this.adventureManager.adventures.has(adventure.id)) return;
    const bossPending = this.isBossFloor(adventure.floor) && !adventure.bossDefeated;
    if (adventure.stairsAvailable && !bossPending) {
      await this.askToUseStairs(adventure);
      return;
    }
    await this.resolveExplorationRoll(adventure, true);
  }

  async askToUseStairs(adventure) {
    const channel = this.getTextChannel(adventure);
    if (!channel) return;
    const row = this.createButtons(adventure, [
      { action: 'stairs_yes', label: '다음 층으로 간다', style: ButtonStyle.Success },
      { action: 'stairs_no', label: '현재 층을 더 탐험한다', style: ButtonStyle.Secondary },
    ]);
    const attachmentName = 'descending-stairs.png';
    const attachment = new AttachmentBuilder(path.join(eventAssetsDirectory, attachmentName));
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle(`🪜 ${adventure.floor + 1}층으로 향하는 계단`)
      .setDescription('희미한 빛이 아래층에서 새어 나옵니다. 다음 층으로 내려가겠습니까?')
      .setImage(`attachment://${attachmentName}`);
    await channel.send({
      embeds: [embed],
      files: [attachment],
      components: [row],
    });
  }

  async resolveExplorationRoll(adventure, includeStairs) {
    const bossPending = this.isBossFloor(adventure.floor) && !adventure.bossDefeated;
    const stairsChance = Math.min(0.65, 0.2 + (adventure.combatsWonThisFloor ?? 0) * 0.1);
    const event = rollExplorationEvent(
      includeStairs && !bossPending,
      bossPending,
      Math.random,
      stairsChance,
    );
    await dungeonLogger.append(adventure.id, 'EXPLORATION_EVENT', {
      floor: adventure.floor,
      event,
      stairsChance,
      stairsIncluded: includeStairs && !bossPending,
      bossPending,
      combatsWonThisFloor: adventure.combatsWonThisFloor ?? 0,
    });
    if (event === 'BOSS') {
      await this.showBossEncounter(adventure);
      return;
    }
    if (event === 'STAIRS') {
      adventure.stairsAvailable = true;
      await this.askToUseStairs(adventure);
      return;
    }
    if (event === 'SPECIAL') {
      await this.showSpecialDoor(adventure);
      return;
    }
    await this.showEnemyEncounter(adventure, false);
  }

  async showEnemyEncounter(adventure, isMimic) {
    const channel = this.getTextChannel(adventure);
    if (!channel) return;
    await this.startBattle(adventure, isMimic);
  }

  async showBossEncounter(adventure) {
    const channel = this.getTextChannel(adventure);
    if (!channel) return;
    const region = getDungeonRegion(adventure.floor);
    const attachmentName = `boss-${adventure.floor}.png`;
    const attachment = new AttachmentBuilder(path.join(monsterAssetsDirectory, region.boss.image), {
      name: attachmentName,
    });
    const embed = new EmbedBuilder()
      .setColor(0x9b111e)
      .setTitle(`⚔️ ${adventure.floor}층 보스 출현`)
      .setDescription(`**${region.boss.name}**이(가) 다음 층으로 향하는 길을 막아섰습니다!`)
      .setImage(`attachment://${attachmentName}`);
    await channel.send({ embeds: [embed], files: [attachment] });
    await this.startBattle(adventure, false, true);
  }

  createMonster(floor, isMimic, partySize = 1, isBoss = false) {
    const region = getDungeonRegion(floor);
    const name = isMimic ? '미믹' : isBoss ? region.boss.name : region.normal.name;
    const level = Math.max(1, floor);
    const rarityMultiplier = isBoss ? 1.8 : isMimic ? 1.25 : 1;
    const combatMultiplier = isBoss ? 1.25 : isMimic ? 1.25 : 1;
    const extraMembers = Math.max(0, partySize - 1);
    const partyHealthMultiplier = 1 + extraMembers * 0.55;
    const partyAttackMultiplier = 1 + extraMembers * 0.18;
    const partyDefenseMultiplier = 1 + extraMembers * 0.12;
    const partySpeedMultiplier = 1 + extraMembers * 0.08;
    const maxHealth = Math.round(
      (30 + level * 15) * rarityMultiplier * partyHealthMultiplier,
    );
    const skills = createMonsterSkillSet(region, { isBoss, isMimic });
    return {
      level,
      isMimic,
      isBoss,
      name,
      regionName: region.regionName,
      imageFile: isMimic ? MONSTER_IMAGE_FILES.미믹 : isBoss ? region.boss.image : region.normal.image,
      maxHealth,
      health: maxHealth,
      attack: Math.round((12 + level * 4) * combatMultiplier * partyAttackMultiplier),
      defense: Math.round((2 + level * 1.2) * combatMultiplier * partyDefenseMultiplier),
      magicDefense: Math.round((1 + level * 1.2) * combatMultiplier * partyDefenseMultiplier),
      speed: Math.round((7 + level) * combatMultiplier * partySpeedMultiplier),
      criticalChance: 5,
      criticalDamage: 150,
      goldReward: Math.round((15 + level * 10) * (isBoss ? 3 : rarityMultiplier)),
      skills,
      skillName: skills[0].name,
    };
  }

  getBaseActionValue(speed) {
    return 10_000 / Math.max(1, speed);
  }

  compareActors(left, right) {
    const timeDifference = left.nextActionAt - right.nextActionAt;
    if (timeDifference !== 0) return timeDifference;
    if (left.type !== right.type) return left.type === 'PLAYER' ? -1 : 1;
    return left.key.localeCompare(right.key);
  }

  calculateDamage(power, defense, attackerLevel, criticalChance, criticalDamage) {
    const levelDefenseBase = 200 + 10 * Math.max(1, attackerLevel);
    const defenseMultiplier = levelDefenseBase / (Math.max(0, defense) + levelDefenseBase);
    const baseDamage = Math.max(1, power * defenseMultiplier);
    const variance = 0.9 + Math.random() * 0.2;
    const critical = Math.random() * 100 < criticalChance;
    const criticalMultiplier = critical ? criticalDamage / 100 : 1;
    return {
      damage: Math.max(1, Math.round(baseDamage * variance * criticalMultiplier)),
      critical,
    };
  }

  async startBattle(adventure, isMimic = false, isBoss = false) {
    const playerStats = {};
    adventure.manaByUser ??= {};
    const manaByUser = adventure.manaByUser;
    for (const userId of adventure.memberIds) {
      const player = await this.playerStore.getOrCreate(userId);
      playerStats[userId] = calculateTotalStats(player);
      manaByUser[userId] = roundMana(
        Math.min(playerStats[userId].mana, Math.max(0, manaByUser[userId] ?? playerStats[userId].mana)),
      );
    }

    const monster = this.createMonster(adventure.floor, isMimic, adventure.memberIds.length, isBoss);
    const actors = [
      ...adventure.memberIds.map((userId) => ({
        key: `PLAYER:${userId}`,
        type: 'PLAYER',
        userId,
        baseSpeed: playerStats[userId].speed,
        speed: playerStats[userId].speed,
        nextActionAt: this.getBaseActionValue(playerStats[userId].speed),
        turnCount: 0,
      })),
      {
        key: 'ENEMY',
        type: 'ENEMY',
        baseSpeed: monster.speed,
        speed: monster.speed,
        nextActionAt: this.getBaseActionValue(monster.speed),
        turnCount: 0,
      },
    ];

    const battle = {
      adventureId: adventure.id,
      monster,
      playerStats,
      manaByUser,
      statusEffectsByUser: Object.fromEntries(adventure.memberIds.map((userId) => [userId, []])),
      playerBuffsByUser: Object.fromEntries(adventure.memberIds.map((userId) => [userId, []])),
      monsterBuffs: [],
      monsterDebuffs: [],
      actors,
      currentTime: 0,
      actionCount: 0,
      partyHasTakenDamage: false,
      partyHasAttacked: false,
      encounterMessage: isBoss
        ? `🔥 **${adventure.floor}층 보스 ${monster.name}**이(가) 나타났습니다!`
        : isMimic
        ? `👹 보물상자가 **${monster.name}**으로 변했습니다!`
        : `👾 **${monster.name}**이(가) 나타났습니다!`,
    };
    this.battles.set(adventure.id, battle);
    await dungeonLogger.append(adventure.id, 'BATTLE_STARTED', {
      floor: adventure.floor,
      encounter: isBoss ? 'BOSS' : isMimic ? 'MIMIC' : 'NORMAL',
      monster: { ...monster },
      players: Object.fromEntries(
        adventure.memberIds.map((userId) => [userId, {
          stats: { ...playerStats[userId] },
          health: adventure.healthByUser[userId],
          maxHealth: adventure.maxHealthByUser[userId],
          mana: manaByUser[userId],
        }]),
      ),
      initialTurnOrder: actors.map((actor) => ({ ...actor })),
    });
    await this.resolveEnemyTurns(adventure, battle);
    if (this.adventureManager.adventures.has(adventure.id)) await this.sendBattleState(adventure, battle);
  }

  getCurrentActor(adventure, battle) {
    battle.actors = battle.actors.filter(
      (actor) => actor.type === 'ENEMY' || adventure.memberIds.includes(actor.userId),
    );
    if (battle.actors.length === 0) return null;
    battle.actors.sort((left, right) => this.compareActors(left, right));
    const actor = battle.actors[0];
    battle.currentTime = Math.max(battle.currentTime, actor.nextActionAt);
    return actor;
  }

  completeActorTurn(adventure, battle, actor) {
    if (actor.type === 'PLAYER') this.advancePlayerBuffDurations(battle, actor.userId);
    actor.nextActionAt += this.getBaseActionValue(actor.speed);
    actor.turnCount = (actor.turnCount ?? 0) + 1;
    battle.actionCount += 1;
    return this.getCurrentActor(adventure, battle);
  }

  getFutureTurnPreview(adventure, battle, limit = 5) {
    const currentActor = this.getCurrentActor(adventure, battle);
    const simulatedActors = battle.actors
      .filter((actor) => actor.type === 'ENEMY' || adventure.memberIds.includes(actor.userId))
      .map((actor) => ({ ...actor }));
    const simulatedCurrentActor = simulatedActors.find((actor) => actor.key === currentActor?.key);
    if (simulatedCurrentActor) {
      simulatedCurrentActor.nextActionAt += this.getBaseActionValue(simulatedCurrentActor.speed);
    }

    const preview = [];
    for (let index = 0; index < limit && simulatedActors.length > 0; index += 1) {
      simulatedActors.sort((left, right) => this.compareActors(left, right));
      const actor = simulatedActors[0];
      preview.push({
        ...actor,
        remainingActionValue: Math.max(0, actor.nextActionAt - battle.currentTime),
      });
      actor.nextActionAt += this.getBaseActionValue(actor.speed);
    }
    return preview;
  }

  selectMonsterSkill(monster, random = Math.random, { forceSingleTarget = false } = {}) {
    const availableSkills = monster.skills.filter((skill) => {
      if (skill.type === 'SELF_HEAL' && monster.health >= monster.maxHealth) return false;
      if (forceSingleTarget && !['SINGLE_ATTACK', 'DRAIN_ATTACK'].includes(skill.type)) return false;
      return true;
    });
    const skills = availableSkills.length > 0 ? availableSkills : monster.skills;
    const totalWeight = skills.reduce((total, skill) => total + (skill.weight ?? 1), 0);
    let roll = random() * totalWeight;
    for (const skill of skills) {
      roll -= skill.weight ?? 1;
      if (roll < 0) return skill;
    }
    return skills.at(-1);
  }

  getPlayerStatusEffects(battle, userId) {
    battle.statusEffectsByUser ??= {};
    battle.statusEffectsByUser[userId] ??= [];
    return battle.statusEffectsByUser[userId];
  }

  getPlayerBuffs(battle, userId) {
    battle.playerBuffsByUser ??= {};
    battle.playerBuffsByUser[userId] ??= [];
    return battle.playerBuffsByUser[userId];
  }

  getEffectivePlayerStats(battle, userId) {
    const baseStats = battle.playerStats[userId];
    if (!baseStats) return null;
    const stats = { ...baseStats };
    for (const buff of this.getPlayerBuffs(battle, userId)) {
      if (buff.type === 'ATTACK_BUFF') {
        stats.attack += buff.amount;
        stats.magicAttack += buff.amount;
      } else if (buff.type === 'DEFENSE_BUFF') {
        stats.defense += buff.amount;
      }
    }
    stats.attack = roundHealth(stats.attack);
    stats.magicAttack = roundHealth(stats.magicAttack);
    stats.defense = roundHealth(stats.defense);
    return stats;
  }

  advancePlayerBuffDurations(battle, userId) {
    const buffs = this.getPlayerBuffs(battle, userId);
    for (const buff of buffs) {
      if (buff.skipNextDecrement) buff.skipNextDecrement = false;
      else buff.remainingTurns -= 1;
    }
    battle.playerBuffsByUser[userId] = buffs.filter((buff) => buff.remainingTurns > 0);
  }

  getActiveTaunt(adventure, battle) {
    battle.monsterDebuffs ??= [];
    battle.monsterDebuffs = battle.monsterDebuffs.filter((debuff) =>
      debuff.remainingTurns > 0 &&
      (debuff.type !== 'TAUNT' || (
        adventure.memberIds.includes(debuff.sourceUserId) &&
        (adventure.healthByUser[debuff.sourceUserId] ?? 0) > 0
      )),
    );
    return battle.monsterDebuffs.find((debuff) => debuff.type === 'TAUNT') ?? null;
  }

  advanceMonsterDebuffDurations(adventure, battle) {
    for (const debuff of battle.monsterDebuffs ?? []) debuff.remainingTurns -= 1;
    return this.getActiveTaunt(adventure, battle);
  }

  formatPlayerBuff(buff) {
    const amount = Number(buff.amount ?? 0).toLocaleString('ko-KR');
    if (buff.type === 'ATTACK_BUFF') return `${buff.name}(공격·마공 +${amount}, ${buff.remainingTurns}턴)`;
    return `${buff.name}(방어 +${amount}, ${buff.remainingTurns}턴)`;
  }

  formatMonsterDebuff(debuff) {
    if (debuff.type === 'TAUNT') {
      return `${debuff.name} → <@${debuff.sourceUserId}> (${debuff.remainingTurns}턴)`;
    }
    return `${debuff.name}(${debuff.remainingTurns}턴)`;
  }

  updatePlayerSpeedFromStatuses(battle, userId) {
    const actor = battle.actors.find((candidate) => candidate.type === 'PLAYER' && candidate.userId === userId);
    if (!actor) return;
    const baseSpeed = actor.baseSpeed ?? battle.playerStats[userId]?.speed ?? actor.speed;
    const reductionPercent = this.getPlayerStatusEffects(battle, userId)
      .filter((effect) => effect.type === 'SLOW')
      .reduce((total, effect) => total + effect.speedReductionPercent, 0);
    const newSpeed = Math.max(1, Math.round(baseSpeed * (1 - Math.min(50, reductionPercent) / 100) * 10) / 10);
    const oldSpeed = Math.max(1, actor.speed);
    if (newSpeed !== oldSpeed && actor.nextActionAt > battle.currentTime) {
      const remainingActionValue = actor.nextActionAt - battle.currentTime;
      actor.nextActionAt = battle.currentTime + remainingActionValue * (oldSpeed / newSpeed);
    }
    actor.speed = newSpeed;
  }

  applyMonsterStatusEffect(battle, userId, skill) {
    const template = skill.statusEffect;
    if (!template) return null;
    const effects = this.getPlayerStatusEffects(battle, userId);
    const status = {
      ...template,
      sourceSkillId: skill.id,
      sourceSkillName: skill.name,
      remainingTurns: template.duration,
    };
    if (status.type === 'DOT') {
      status.damage = Math.max(1, Math.round(battle.monster.attack * status.damageCoefficient));
    }
    const existing = effects.find((effect) => effect.type === status.type);
    if (existing) Object.assign(existing, status);
    else effects.push(status);
    if (status.type === 'SLOW') this.updatePlayerSpeedFromStatuses(battle, userId);
    return existing ?? status;
  }

  formatMonsterStatusEffect(status) {
    if (status.type === 'SLOW') {
      return `🐌 **${status.name}**: 속도가 **${status.speedReductionPercent}% 감소**합니다. (${status.remainingTurns}턴 남음)`;
    }
    return `☠️ **${status.name}**: 자신의 턴이 시작될 때 **${status.damage} 피해**를 받습니다. (${status.remainingTurns}턴 남음)`;
  }

  async processPlayerTurnStart(adventure, battle, actor) {
    const turnKey = `${actor.key}:${actor.turnCount ?? 0}`;
    if (battle.processedPlayerTurnKey === turnKey) return true;
    battle.processedPlayerTurnKey = turnKey;
    const effects = this.getPlayerStatusEffects(battle, actor.userId);
    if (effects.length === 0) return true;

    for (const effect of effects.filter((candidate) => candidate.type === 'DOT')) {
      const healthBefore = adventure.healthByUser[actor.userId];
      const healthAfter = roundHealth(healthBefore - effect.damage);
      const remainingTurnsAfter = Math.max(0, effect.remainingTurns - 1);
      const lostRewards = healthAfter === 0
        ? await this.removeAdventureDeathRewards(adventure, actor.userId)
        : { equipment: [], gold: 0 };
      await dungeonLogger.append(adventure.id, 'STATUS_TICK', {
        floor: adventure.floor,
        turn: battle.actionCount + 1,
        userId: actor.userId,
        statusType: effect.type,
        statusName: effect.name,
        sourceSkillId: effect.sourceSkillId,
        damage: effect.damage,
        healthBefore,
        healthAfter,
        remainingTurnsAfter,
        lostEquipment: lostRewards.equipment.map((item) => item.id),
        lostGold: lostRewards.gold,
      });
      await this.getTextChannel(adventure)?.send([
        `## ☠️ <@${actor.userId}>님의 턴 시작 · ${effect.name}`,
        `# 💥 ${effect.damage} 지속 피해`,
        `남은 체력: **${healthAfter}/${adventure.maxHealthByUser[actor.userId]}**`,
        remainingTurnsAfter > 0 ? `남은 지속시간: **${remainingTurnsAfter}턴**` : `**${effect.name} 효과가 종료됩니다.**`,
        lostRewards.equipment.length > 0 || lostRewards.gold > 0
          ? `☠️ 사망하여 이번 모험 보상 장비 **${lostRewards.equipment.length}개**, 골드 **${lostRewards.gold}G**를 잃었습니다.`
          : null,
      ].filter(Boolean).join('\n'));
      battle.partyHasTakenDamage = true;
      await this.adventureManager.damage(this.client, actor.userId, effect.damage);
      if (!this.adventureManager.adventures.has(adventure.id)) {
        this.cleanup(adventure.id);
        return false;
      }
      if (!adventure.memberIds.includes(actor.userId)) return false;
    }

    for (const effect of effects) effect.remainingTurns -= 1;
    const expiredEffects = effects.filter((effect) => effect.remainingTurns <= 0);
    battle.statusEffectsByUser[actor.userId] = effects.filter((effect) => effect.remainingTurns > 0);
    if (expiredEffects.some((effect) => effect.type === 'SLOW')) {
      this.updatePlayerSpeedFromStatuses(battle, actor.userId);
    }
    if (expiredEffects.length > 0) {
      await this.getTextChannel(adventure)?.send(
        `✨ <@${actor.userId}>님의 ${expiredEffects.map((effect) => `**${effect.name}**`).join(', ')} 상태가 해제되었습니다.`,
      );
    }
    return true;
  }

  async resolveEnemyTurns(adventure, battle) {
    let actor = this.getCurrentActor(adventure, battle);
    while (actor?.type === 'ENEMY' && adventure.memberIds.length > 0) {
      const livingTargets = adventure.memberIds.filter(
        (userId) => (adventure.healthByUser[userId] ?? 0) > 0,
      );
      if (livingTargets.length === 0) return;
      const activeTaunt = this.getActiveTaunt(adventure, battle);
      const skill = this.selectMonsterSkill(
        battle.monster,
        Math.random,
        { forceSingleTarget: Boolean(activeTaunt) },
      );
      const channel = this.getTextChannel(adventure);
      const visual = this.createMonsterTurnVisual(battle.monster, skill);
      const tauntStatusAfterTurn = activeTaunt
        ? activeTaunt.remainingTurns > 1
          ? `🛡️ 도발 대상: <@${activeTaunt.sourceUserId}> · **${activeTaunt.remainingTurns - 1}턴 남음**`
          : '✨ **도발 효과가 종료됩니다.**'
        : null;

      if (skill.type === 'SELF_HEAL') {
        const healthBefore = battle.monster.health;
        const healAmount = Math.max(1, Math.round(battle.monster.maxHealth * skill.maxHealthCoefficient));
        battle.monster.health = Math.min(battle.monster.maxHealth, healthBefore + healAmount);
        const recovered = battle.monster.health - healthBefore;
        await dungeonLogger.append(adventure.id, 'TURN_ACTION', {
          floor: adventure.floor,
          turn: battle.actionCount + 1,
          actorType: 'ENEMY',
          actorId: 'ENEMY',
          actorName: battle.monster.name,
          action: skill.name,
          skillId: skill.id,
          skillType: skill.type,
          healing: recovered,
          monsterHealthBefore: healthBefore,
          monsterHealthAfter: battle.monster.health,
          activeTaunt: activeTaunt ? { ...activeTaunt } : null,
        });
        await channel?.send({
          content: [
            TURN_SEPARATOR,
            `## 🔴 ${battle.monster.name}의 턴`,
            `### 👹 「${skill.name}」 시전`,
            `# 💚 체력 ${recovered} 회복`,
            `적의 체력: **${battle.monster.health}/${battle.monster.maxHealth}**`,
            tauntStatusAfterTurn,
            TURN_SEPARATOR,
          ].filter(Boolean).join('\n'),
          embeds: [visual.embed],
          files: [visual.attachment],
        });
      } else {
        const targetIds = activeTaunt
          ? [activeTaunt.sourceUserId]
          : skill.type === 'PARTY_ATTACK'
          ? [...livingTargets]
          : [livingTargets[Math.floor(Math.random() * livingTargets.length)]];
        const results = [];
        for (const targetId of targetIds) {
          const targetStats = this.getEffectivePlayerStats(battle, targetId);
          const result = this.calculateDamage(
            battle.monster.attack * skill.powerCoefficient,
            targetStats.defense,
            battle.monster.level,
            battle.monster.criticalChance + (skill.criticalChanceBonus ?? 0),
            battle.monster.criticalDamage,
          );
          const healthBefore = adventure.healthByUser[targetId];
          const expectedHealth = roundHealth(healthBefore - result.damage);
          const lostRewards = expectedHealth === 0
            ? await this.removeAdventureDeathRewards(adventure, targetId)
            : { equipment: [], gold: 0 };
          const appliedStatus = expectedHealth > 0
            ? this.applyMonsterStatusEffect(battle, targetId, skill)
            : null;
          results.push({
            targetId,
            targetDefense: targetStats.defense,
            damage: result.damage,
            effectiveDamage: Math.min(result.damage, healthBefore),
            critical: result.critical,
            healthBefore,
            healthAfter: expectedHealth,
            maxHealth: adventure.maxHealthByUser[targetId],
            lostRewards,
            appliedStatus,
          });
        }
        if (results.some((result) => result.damage > 0)) battle.partyHasTakenDamage = true;
        let lifeSteal = null;
        if (skill.type === 'DRAIN_ATTACK') {
          const monsterHealthBefore = battle.monster.health;
          const absorbedDamage = results.reduce((total, result) => total + result.effectiveDamage, 0);
          const requestedHealing = Math.max(1, Math.round(absorbedDamage * skill.lifeStealRatio));
          battle.monster.health = Math.min(battle.monster.maxHealth, monsterHealthBefore + requestedHealing);
          lifeSteal = {
            ratio: skill.lifeStealRatio,
            absorbedDamage,
            healing: battle.monster.health - monsterHealthBefore,
            monsterHealthBefore,
            monsterHealthAfter: battle.monster.health,
          };
        }
        await dungeonLogger.append(adventure.id, 'TURN_ACTION', {
          floor: adventure.floor,
          turn: battle.actionCount + 1,
          actorType: 'ENEMY',
          actorId: 'ENEMY',
          actorName: battle.monster.name,
          action: skill.name,
          skillId: skill.id,
          skillType: skill.type,
          powerCoefficient: skill.powerCoefficient,
          activeTaunt: activeTaunt ? { ...activeTaunt } : null,
          lifeSteal,
          targets: results.map((result) => ({
            targetId: result.targetId,
            targetDefense: result.targetDefense,
            damage: result.damage,
            critical: result.critical,
            targetHealthBefore: result.healthBefore,
            targetHealthAfter: result.healthAfter,
            appliedStatus: result.appliedStatus ? { ...result.appliedStatus } : null,
            lostEquipment: result.lostRewards.equipment.map((item) => ({
              id: item.id,
              name: item.name,
              itemLevel: item.itemLevel,
              rarity: item.rarity,
              enhancement: item.enhancement,
            })),
            lostGold: result.lostRewards.gold,
          })),
        });
        const damageLines = results.flatMap((result) => [
          `${skill.type === 'PARTY_ATTACK' ? '💥' : '# 💥'} <@${result.targetId}> **${result.damage} 피해**${result.critical ? ' · 치명타!' : ''}`,
          `남은 체력: **${result.healthAfter}/${result.maxHealth}**`,
          result.lostRewards.equipment.length > 0 || result.lostRewards.gold > 0
            ? `☠️ 사망하여 이번 모험 보상 장비 **${result.lostRewards.equipment.length}개**, 골드 **${result.lostRewards.gold}G**를 잃었습니다.`
            : null,
          result.appliedStatus ? this.formatMonsterStatusEffect(result.appliedStatus) : null,
        ].filter(Boolean));
        const lifeStealLine = lifeSteal
          ? `🩸 실제 피해의 **${Math.round(lifeSteal.ratio * 100)}%**를 흡수해 체력 **${lifeSteal.healing}** 회복 (${lifeSteal.monsterHealthBefore} → ${lifeSteal.monsterHealthAfter}/${battle.monster.maxHealth})`
          : null;
        await channel?.send({
          content: [
            TURN_SEPARATOR,
            `## 🔴 ${battle.monster.name}의 턴`,
            `### 👹 「${skill.name}」 시전`,
            skill.type === 'PARTY_ATTACK' ? '# 🌋 파티 전체 공격' : null,
            ...damageLines,
            lifeStealLine,
            tauntStatusAfterTurn,
            TURN_SEPARATOR,
          ].filter(Boolean).join('\n'),
          embeds: [visual.embed],
          files: [visual.attachment],
        });

        for (const result of results) {
          await this.adventureManager.damage(this.client, result.targetId, result.damage);
          if (!this.adventureManager.adventures.has(adventure.id)) {
            this.cleanup(adventure.id);
            return;
          }
        }
      }

      this.advanceMonsterDebuffDurations(adventure, battle);

      await this.waitAfterBattleAction();
      if (
        !this.adventureManager.adventures.has(adventure.id) ||
        this.battles.get(adventure.id) !== battle
      ) return;
      actor = this.completeActorTurn(adventure, battle, actor);
    }
  }

  createBattleStatus(adventure, battle) {
    const actor = this.getCurrentActor(adventure, battle);
    const partyStatus = adventure.memberIds
      .map((userId) => {
        const stats = this.getEffectivePlayerStats(battle, userId);
        const health = adventure.healthByUser[userId];
        const maxHealth = adventure.maxHealthByUser[userId];
        const mana = battle.manaByUser[userId];
        const statusEffects = this.getPlayerStatusEffects(battle, userId);
        const buffs = this.getPlayerBuffs(battle, userId);
        return [
          `<@${userId}> · Lv.${stats.playerLevel}`,
          `❤️ 체력 ${this.createResourceBar(health, maxHealth, HEALTH_BAR_FILLED)} ${health}/${maxHealth}`,
          `🔷 마나 ${this.createResourceBar(mana, stats.mana, MANA_BAR_FILLED)} ${mana}/${stats.mana}`,
          `⚔️ 공격력 ${stats.attack}\t✨ 마법 공격력 ${stats.magicAttack}`,
          `🎯 치명타 확률 ${stats.criticalChance}%\t💥 치명타 피해 ${stats.criticalDamage}%`,
          `⬆️ 버프: ${buffs.length > 0 ? buffs.map((buff) => this.formatPlayerBuff(buff)).join(', ') : '없음'}`,
          `⬇️ 디버프: ${statusEffects.length > 0 ? statusEffects.map((effect) => `${effect.name}(${effect.remainingTurns}턴)`).join(', ') : '없음'}`,
        ].join('\n');
      })
      .join('\n');
    const monsterBuffs = battle.monsterBuffs ?? [];
    const monsterDebuffs = battle.monsterDebuffs ?? [];
    const monsterStatus = [
      `👹 Lv.${battle.monster.level} ${battle.monster.name} · 체력 ${battle.monster.health}/${battle.monster.maxHealth}`,
      `⬆️ 버프: ${monsterBuffs.length > 0 ? monsterBuffs.map((buff) => `${buff.name}(${buff.remainingTurns}턴)`).join(', ') : '없음'}`,
      `⬇️ 디버프: ${monsterDebuffs.length > 0 ? monsterDebuffs.map((debuff) => this.formatMonsterDebuff(debuff)).join(', ') : '없음'}`,
    ].join('\n');
    const upcomingOrder = this.getFutureTurnPreview(adventure, battle, 5)
      .map((nextActor, index) => {
        const name = nextActor.type === 'PLAYER' ? `<@${nextActor.userId}>` : battle.monster.name;
        return `${index + 1}. ${name}(${Math.ceil(nextActor.remainingActionValue)})`;
      })
      .join(' → ');
    return [
      TURN_SEPARATOR,
      `# 🟢 <@${actor.userId}>님의 턴 · ${adventure.floor}층`,
      battle.actionCount === 0 ? battle.encounterMessage : null,
      '**파티 상태**',
      partyStatus,
      '**적 상태**',
      monsterStatus,
      `**다음 5턴** ${upcomingOrder}`,
      TURN_SEPARATOR,
    ].filter(Boolean).join('\n');
  }

  createResourceBar(current, maximum, filledBox) {
    if (!Number.isFinite(maximum) || maximum <= 0) {
      return RESOURCE_BAR_EMPTY.repeat(RESOURCE_BAR_SEGMENTS);
    }
    const ratio = Math.min(1, Math.max(0, current / maximum));
    const filledSegments = Math.round(ratio * RESOURCE_BAR_SEGMENTS);
    return filledBox.repeat(filledSegments) +
      RESOURCE_BAR_EMPTY.repeat(RESOURCE_BAR_SEGMENTS - filledSegments);
  }

  async sendBattleState(adventure, battle) {
    const channel = this.getTextChannel(adventure);
    let actor = this.getCurrentActor(adventure, battle);
    if (!channel || actor?.type !== 'PLAYER') return;
    const canAct = await this.processPlayerTurnStart(adventure, battle, actor);
    if (!canAct) {
      if (!this.adventureManager.adventures.has(adventure.id)) return;
      await this.resolveEnemyTurns(adventure, battle);
      if (this.adventureManager.adventures.has(adventure.id)) await this.sendBattleState(adventure, battle);
      return;
    }
    actor = this.getCurrentActor(adventure, battle);
    if (actor?.type !== 'PLAYER') {
      await this.resolveEnemyTurns(adventure, battle);
      if (this.adventureManager.adventures.has(adventure.id)) await this.sendBattleState(adventure, battle);
      return;
    }
    const row = this.createButtons(
      adventure,
      [
        { action: 'battle_attack', label: '일반 공격 · 현재 턴 전용', style: ButtonStyle.Danger },
        { action: 'battle_skill', label: '스킬 · 현재 턴 전용', style: ButtonStyle.Primary },
        { action: 'battle_item', label: '아이템 사용 · 현재 턴 전용', style: ButtonStyle.Success },
      ],
      actor.userId,
    );
    const monsterVisual = this.createMonsterBattleVisual(battle.monster, adventure, actor.userId);
    const payload = {
      content: this.createBattleStatus(adventure, battle),
      embeds: [monsterVisual.embed],
      files: [monsterVisual.attachment],
      components: [row],
    };
    try {
      battle.turnMessage = await channel.send(payload);
    } catch (error) {
      console.error(`${adventure.floor}층 몬스터 이미지가 포함된 턴 전송에 실패해 재시도합니다.`, error);
      battle.turnMessage = await channel.send(payload);
    }
  }

  async handleBattleAction(interaction, adventure, action) {
    const battle = this.battles.get(adventure.id);
    const actor = battle && this.getCurrentActor(adventure, battle);
    if (!battle || actor?.type !== 'PLAYER') {
      await interaction.reply({ content: '현재 진행 중인 전투가 없습니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (actor.userId !== interaction.user.id) {
      await interaction.reply({ content: '지금은 다른 파티원의 턴입니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === 'battle_item') {
      const player = await this.playerStore.getOrCreate(actor.userId);
      const ownedPotions = player.itemInventory.filter(
        (item) => item.quantity > 0 && getPotion(item.id),
      );
      if (ownedPotions.length === 0) {
        await interaction.reply({
          content: '현재 사용할 수 있는 포션이 없습니다.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const rows = [];
      for (let index = 0; index < ownedPotions.length; index += 4) {
        rows.push(
          new ActionRowBuilder().addComponents(
            ownedPotions.slice(index, index + 4).map((item) =>
              new ButtonBuilder()
                .setCustomId(`potion:${adventure.currentActionToken}:${item.id}:${actor.userId}`)
                .setLabel(`${item.name} ×${item.quantity}`)
                .setStyle(getPotion(item.id).type === 'HEALTH' ? ButtonStyle.Danger : ButtonStyle.Primary),
            ),
          ),
        );
      }
      await interaction.reply({
        content: '이번 턴에 사용할 포션을 선택하세요.',
        components: rows,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (action === 'battle_skill') {
      const player = await this.playerStore.getOrCreate(actor.userId);
      const equippedSkills = player.equippedSkills
        .map((skillId) => getSkill(skillId))
        .filter(Boolean);
      if (equippedSkills.length === 0) {
        await interaction.reply({
          content: '장착한 스킬이 없습니다. 모험 밖에서 /스킬장착을 사용해 주세요.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const row = new ActionRowBuilder().addComponents(
        equippedSkills.map((skill) =>
          new ButtonBuilder()
            .setCustomId(`skill:${adventure.currentActionToken}:${skill.id}:${actor.userId}`)
            .setLabel(`${skill.name} · 마나 ${skill.manaCost}`)
            .setStyle(
              skill.type === 'ATTACK'
                ? ButtonStyle.Danger
                : skill.type === 'HEAL'
                  ? ButtonStyle.Success
                  : skill.type === 'TAUNT'
                    ? ButtonStyle.Secondary
                    : ButtonStyle.Primary,
            ),
        ),
      );
      await interaction.reply({
        content: '이번 턴에 시전할 스킬을 선택하세요.',
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const stats = this.getEffectivePlayerStats(battle, actor.userId);
    const result = this.calculateDamage(
      stats.attack,
      battle.monster.defense,
      stats.playerLevel,
      stats.criticalChance,
      stats.criticalDamage,
    );
    const monsterHealthBefore = battle.monster.health;
    battle.monster.health = Math.max(0, battle.monster.health - result.damage);
    battle.partyHasAttacked = true;
    adventure.currentActionToken = null;
    await dungeonLogger.append(adventure.id, 'TURN_ACTION', {
      floor: adventure.floor,
      turn: battle.actionCount + 1,
      actorType: 'PLAYER',
      actorId: actor.userId,
      action: 'NORMAL_ATTACK',
      targetId: 'ENEMY',
      attack: stats.attack,
      damage: result.damage,
      critical: result.critical,
      monsterHealthBefore,
      monsterHealthAfter: battle.monster.health,
    });
    await interaction.update({
      content: [
        TURN_SEPARATOR,
        `## 🟢 <@${actor.userId}>님의 턴`,
        '### 🗡️ 「일반 공격」 시전',
        `# 💥 ${result.damage} 피해${result.critical ? ' · 치명타!' : ''}`,
        `${battle.monster.name} 공격받음`,
        `적의 남은 체력: **${battle.monster.health}/${battle.monster.maxHealth}**`,
        TURN_SEPARATOR,
      ].join('\n'),
      components: [],
    });

    await this.waitAfterBattleAction();
    if (
      !this.adventureManager.adventures.has(adventure.id) ||
      this.battles.get(adventure.id) !== battle
    ) return;

    if (battle.monster.health === 0) {
      await this.finishBattleVictory(adventure, battle);
      return;
    }

    this.completeActorTurn(adventure, battle, actor);
    await this.resolveEnemyTurns(adventure, battle);
    if (this.adventureManager.adventures.has(adventure.id)) await this.sendBattleState(adventure, battle);
  }

  async handleSkillButton(interaction) {
    if (!interaction.customId.startsWith('skill:')) return false;
    const [, token, skillId, ownerId] = interaction.customId.split(':');
    if (interaction.user.id !== ownerId) {
      await interaction.reply({
        content: '현재 턴 플레이어만 스킬을 선택할 수 있습니다.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const adventure = this.adventureManager.getByUser(ownerId);
    const battle = adventure && this.battles.get(adventure.id);
    const actor = battle && this.getCurrentActor(adventure, battle);
    const player = await this.playerStore.getOrCreate(ownerId);
    if (
      !adventure ||
      !battle ||
      interaction.channelId !== adventure.textChannelId ||
      token !== adventure.currentActionToken ||
      actor?.userId !== ownerId ||
      !player.equippedSkills.includes(skillId)
    ) {
      await interaction.reply({ content: '이미 지나간 턴이거나 장착하지 않은 스킬입니다.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const skill = getSkill(skillId);
    if (!skill || battle.manaByUser[ownerId] < skill.manaCost) {
      await interaction.reply({ content: '스킬 시전에 필요한 마나가 부족합니다.', flags: MessageFlags.Ephemeral });
      return true;
    }

    if (skill.type === 'ATTACK' && skill.targetType === 'ENEMY') {
      return this.executeAttackSkill(interaction, adventure, battle, actor, skill);
    }
    if (skill.type === 'TAUNT' && skill.targetType === 'ENEMY') {
      return this.executeTauntSkill(interaction, adventure, battle, actor, skill);
    }
    if (!['HEAL', 'ATTACK_BUFF', 'DEFENSE_BUFF'].includes(skill.type) || skill.targetType !== 'ALLY') {
      await interaction.reply({ content: '아직 사용할 수 없는 스킬 유형입니다.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const guild = this.client.guilds.cache.get(adventure.guildId);
    const rows = [];
    for (let index = 0; index < adventure.memberIds.length; index += 5) {
      rows.push(
        new ActionRowBuilder().addComponents(
          adventure.memberIds.slice(index, index + 5).map((targetId) => {
            const targetName = guild?.members.cache.get(targetId)?.displayName ?? targetId;
            return new ButtonBuilder()
              .setCustomId(`skill_target:${token}:${skillId}:${targetId}:${ownerId}`)
              .setLabel(targetId === ownerId ? `${targetName} (나)` : targetName)
              .setStyle(skill.type === 'HEAL' ? ButtonStyle.Success : ButtonStyle.Primary);
          }),
        ),
      );
    }
    await interaction.update({
      content: `「${skill.name}」을(를) 사용할 대상을 선택하세요.`,
      components: rows,
    });
    return true;
  }

  async executeAttackSkill(interaction, adventure, battle, actor, skill) {
    const ownerId = actor.userId;
    const stats = this.getEffectivePlayerStats(battle, ownerId);
    const attackPower = calculateSkillAttackPower(skill, stats.magicAttack);
    const result = this.calculateDamage(
      attackPower,
      battle.monster.magicDefense,
      stats.playerLevel,
      stats.criticalChance,
      stats.criticalDamage,
    );
    const monsterHealthBefore = battle.monster.health;
    const manaBefore = battle.manaByUser[ownerId];
    battle.monster.health = Math.max(0, battle.monster.health - result.damage);
    battle.manaByUser[ownerId] = roundMana(manaBefore - skill.manaCost);
    battle.partyHasAttacked = true;
    adventure.currentActionToken = null;

    await dungeonLogger.append(adventure.id, 'TURN_ACTION', {
      floor: adventure.floor,
      turn: battle.actionCount + 1,
      actorType: 'PLAYER',
      actorId: ownerId,
      action: 'ATTACK_SKILL',
      skillId: skill.id,
      skillName: skill.name,
      targetId: 'ENEMY',
      magicAttack: stats.magicAttack,
      coefficient: skill.magicAttackCoefficient,
      attackPower,
      damage: result.damage,
      critical: result.critical,
      monsterHealthBefore,
      monsterHealthAfter: battle.monster.health,
      manaBefore,
      manaAfter: battle.manaByUser[ownerId],
    });
    await battle.turnMessage?.edit({
      content: [
        TURN_SEPARATOR,
        `## 🟢 <@${ownerId}>님의 턴`,
        `### ✨ 「${skill.name}」 시전`,
        `# 💥 ${result.damage} 마법 피해${result.critical ? ' · 치명타!' : ''}`,
        `${battle.monster.name} 공격받음`,
        `적의 남은 체력: **${battle.monster.health}/${battle.monster.maxHealth}**`,
        `소모 마나: **${skill.manaCost}** · 남은 마나: **${battle.manaByUser[ownerId]}**`,
        TURN_SEPARATOR,
      ].join('\n'),
      components: [],
    });
    await interaction.update({ content: `${skill.name} 시전을 완료했습니다.`, components: [] });

    await this.waitAfterBattleAction();
    if (
      !this.adventureManager.adventures.has(adventure.id) ||
      this.battles.get(adventure.id) !== battle
    ) return true;
    if (battle.monster.health === 0) {
      await this.finishBattleVictory(adventure, battle);
      return true;
    }
    this.completeActorTurn(adventure, battle, actor);
    await this.resolveEnemyTurns(adventure, battle);
    if (this.adventureManager.adventures.has(adventure.id)) await this.sendBattleState(adventure, battle);
    return true;
  }

  async executeTauntSkill(interaction, adventure, battle, actor, skill) {
    const ownerId = actor.userId;
    const manaBefore = battle.manaByUser[ownerId];
    const taunt = {
      id: skill.id,
      type: 'TAUNT',
      name: skill.name,
      sourceUserId: ownerId,
      remainingTurns: skill.duration,
    };
    battle.monsterDebuffs ??= [];
    const existing = battle.monsterDebuffs.find((debuff) => debuff.type === 'TAUNT');
    if (existing) Object.assign(existing, taunt);
    else battle.monsterDebuffs.push(taunt);
    battle.manaByUser[ownerId] = roundMana(manaBefore - skill.manaCost);
    adventure.currentActionToken = null;

    await dungeonLogger.append(adventure.id, 'TURN_ACTION', {
      floor: adventure.floor,
      turn: battle.actionCount + 1,
      actorType: 'PLAYER',
      actorId: ownerId,
      action: 'TAUNT_SKILL',
      skillId: skill.id,
      skillName: skill.name,
      targetId: 'ENEMY',
      duration: skill.duration,
      manaBefore,
      manaAfter: battle.manaByUser[ownerId],
    });
    await battle.turnMessage?.edit({
      content: [
        TURN_SEPARATOR,
        `## 🟢 <@${ownerId}>님의 턴`,
        `### 🛡️ 「${skill.name}」 시전`,
        `👹 ${battle.monster.name}에게 **도발**을 부여했습니다.`,
        `적은 <@${ownerId}>만 공격합니다. · **${skill.duration} 적 턴 남음**`,
        `소모 마나: **${skill.manaCost}** · 남은 마나: **${battle.manaByUser[ownerId]}**`,
        TURN_SEPARATOR,
      ].join('\n'),
      components: [],
    });
    await interaction.update({ content: `${skill.name} 시전을 완료했습니다.`, components: [] });

    await this.waitAfterBattleAction();
    if (
      !this.adventureManager.adventures.has(adventure.id) ||
      this.battles.get(adventure.id) !== battle
    ) return true;
    this.completeActorTurn(adventure, battle, actor);
    await this.resolveEnemyTurns(adventure, battle);
    if (this.adventureManager.adventures.has(adventure.id)) await this.sendBattleState(adventure, battle);
    return true;
  }

  async executeAllyBuffSkill(interaction, adventure, battle, actor, skill, targetId) {
    const ownerId = actor.userId;
    const casterStats = this.getEffectivePlayerStats(battle, ownerId);
    const amount = roundHealth(Math.max(1, casterStats.magicAttack * skill.magicAttackCoefficient));
    const buffs = this.getPlayerBuffs(battle, targetId);
    const appliedBuff = {
      id: skill.id,
      type: skill.type,
      name: skill.name,
      sourceUserId: ownerId,
      amount,
      remainingTurns: skill.duration,
      skipNextDecrement: targetId === ownerId,
    };
    const existing = buffs.find((buff) => buff.type === skill.type);
    if (existing) Object.assign(existing, appliedBuff);
    else buffs.push(appliedBuff);
    const manaBefore = battle.manaByUser[ownerId];
    battle.manaByUser[ownerId] = roundMana(manaBefore - skill.manaCost);
    adventure.currentActionToken = null;
    const statLabel = skill.type === 'ATTACK_BUFF'
      ? `공격력·마법 공격력 **+${amount}**`
      : `방어력 **+${amount}**`;

    await dungeonLogger.append(adventure.id, 'TURN_ACTION', {
      floor: adventure.floor,
      turn: battle.actionCount + 1,
      actorType: 'PLAYER',
      actorId: ownerId,
      action: 'ALLY_BUFF_SKILL',
      skillId: skill.id,
      skillName: skill.name,
      targetId,
      buffType: skill.type,
      buffAmount: amount,
      duration: skill.duration,
      casterMagicAttack: casterStats.magicAttack,
      manaBefore,
      manaAfter: battle.manaByUser[ownerId],
    });
    await battle.turnMessage?.edit({
      content: [
        TURN_SEPARATOR,
        `## 🟢 <@${ownerId}>님의 턴`,
        `### ✨ 「${skill.name}」 시전`,
        `<@${targetId}>에게 ${statLabel} 버프를 부여했습니다.`,
        `지속시간: **${skill.duration}턴**`,
        `소모 마나: **${skill.manaCost}** · 남은 마나: **${battle.manaByUser[ownerId]}**`,
        TURN_SEPARATOR,
      ].join('\n'),
      components: [],
    });
    await interaction.update({ content: `${skill.name} 시전을 완료했습니다.`, components: [] });

    await this.waitAfterBattleAction();
    if (
      !this.adventureManager.adventures.has(adventure.id) ||
      this.battles.get(adventure.id) !== battle
    ) return true;
    this.completeActorTurn(adventure, battle, actor);
    await this.resolveEnemyTurns(adventure, battle);
    if (this.adventureManager.adventures.has(adventure.id)) await this.sendBattleState(adventure, battle);
    return true;
  }

  async handleSkillTargetButton(interaction) {
    if (!interaction.customId.startsWith('skill_target:')) return false;
    const [, token, skillId, targetId, ownerId] = interaction.customId.split(':');
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: '현재 턴 플레이어만 대상을 선택할 수 있습니다.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const adventure = this.adventureManager.getByUser(ownerId);
    const battle = adventure && this.battles.get(adventure.id);
    const actor = battle && this.getCurrentActor(adventure, battle);
    const player = await this.playerStore.getOrCreate(ownerId);
    const skill = getSkill(skillId);
    if (
      !adventure ||
      !battle ||
      interaction.channelId !== adventure.textChannelId ||
      token !== adventure.currentActionToken ||
      actor?.userId !== ownerId ||
      !adventure.memberIds.includes(targetId) ||
      !player.equippedSkills.includes(skillId) ||
      !skill ||
      !['HEAL', 'ATTACK_BUFF', 'DEFENSE_BUFF'].includes(skill.type) ||
      skill.targetType !== 'ALLY'
    ) {
      await interaction.reply({ content: '이미 지나간 턴이거나 올바르지 않은 대상입니다.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (battle.manaByUser[ownerId] < skill.manaCost) {
      await interaction.reply({ content: '스킬 시전에 필요한 마나가 부족합니다.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (['ATTACK_BUFF', 'DEFENSE_BUFF'].includes(skill.type)) {
      return this.executeAllyBuffSkill(interaction, adventure, battle, actor, skill, targetId);
    }
    const before = adventure.healthByUser[targetId];
    const maxHealth = adventure.maxHealthByUser[targetId];
    if (before >= maxHealth) {
      await interaction.reply({ content: '대상의 체력이 이미 최대입니다.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const healing = calculateSkillHealing(skill, this.getEffectivePlayerStats(battle, ownerId).magicAttack);
    const after = roundHealth(Math.min(maxHealth, before + healing));
    const manaBefore = battle.manaByUser[ownerId];
    adventure.healthByUser[targetId] = after;
    battle.manaByUser[ownerId] = roundMana(battle.manaByUser[ownerId] - skill.manaCost);
    adventure.currentActionToken = null;
    await dungeonLogger.append(adventure.id, 'TURN_ACTION', {
      floor: adventure.floor,
      turn: battle.actionCount + 1,
      actorType: 'PLAYER',
      actorId: ownerId,
      action: 'SKILL',
      skillId: skill.id,
      skillName: skill.name,
      targetId,
      healing: after - before,
      targetHealthBefore: before,
      targetHealthAfter: after,
      manaBefore,
      manaAfter: battle.manaByUser[ownerId],
    });
    await battle.turnMessage?.edit({
      content: [
        TURN_SEPARATOR,
        `## 🟢 <@${ownerId}>님의 턴`,
        `### ✨ 「${skill.name}」 시전`,
        `<@${targetId}>의 체력을 **${after - before}** 회복했습니다. (${before} → ${after}/${maxHealth})`,
        `소모 마나: **${skill.manaCost}** · 남은 마나: **${battle.manaByUser[ownerId]}**`,
        TURN_SEPARATOR,
      ].join('\n'),
      components: [],
    });
    await interaction.update({ content: `${skill.name} 시전을 완료했습니다.`, components: [] });

    await this.waitAfterBattleAction();
    if (
      !this.adventureManager.adventures.has(adventure.id) ||
      this.battles.get(adventure.id) !== battle
    ) return true;
    this.completeActorTurn(adventure, battle, actor);
    await this.resolveEnemyTurns(adventure, battle);
    if (this.adventureManager.adventures.has(adventure.id)) await this.sendBattleState(adventure, battle);
    return true;
  }

  async handlePotionButton(interaction) {
    if (!interaction.customId.startsWith('potion:')) return false;
    const [, token, itemId, ownerId] = interaction.customId.split(':');
    if (interaction.user.id !== ownerId) {
      await interaction.reply({
        content: '현재 턴 플레이어만 이 포션을 사용할 수 있습니다.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const adventure = this.adventureManager.getByUser(ownerId);
    const battle = adventure && this.battles.get(adventure.id);
    const actor = battle && this.getCurrentActor(adventure, battle);
    if (
      !adventure ||
      !battle ||
      interaction.channelId !== adventure.textChannelId ||
      token !== adventure.currentActionToken ||
      actor?.type !== 'PLAYER' ||
      actor.userId !== ownerId
    ) {
      await interaction.reply({ content: '이미 지나간 턴입니다.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const potion = getPotion(itemId);
    if (!potion) {
      await interaction.reply({ content: '존재하지 않는 아이템입니다.', flags: MessageFlags.Ephemeral });
      return true;
    }

    let before;
    let after;
    let max;
    if (potion.type === 'HEALTH') {
      before = adventure.healthByUser[ownerId];
      max = adventure.maxHealthByUser[ownerId];
      after = roundHealth(Math.min(max, before + Math.max(1, Math.round(max * potion.recoveryRatio))));
    } else {
      before = battle.manaByUser[ownerId];
      max = battle.playerStats[ownerId].mana;
      after = roundMana(Math.min(max, before + Math.max(1, Math.round(max * potion.recoveryRatio))));
    }
    if (before >= max) {
      await interaction.reply({
        content: `${potion.type === 'HEALTH' ? '체력' : '마나'}가 이미 최대치입니다. 포션을 사용하지 않았습니다.`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const consumed = await this.playerStore.consumeItem(ownerId, itemId);
    if (!consumed.ok) {
      await interaction.reply({ content: '보유한 포션이 없습니다.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (potion.type === 'HEALTH') adventure.healthByUser[ownerId] = after;
    else battle.manaByUser[ownerId] = after;

    adventure.currentActionToken = null;
    await dungeonLogger.append(adventure.id, 'TURN_ACTION', {
      floor: adventure.floor,
      turn: battle.actionCount + 1,
      actorType: 'PLAYER',
      actorId: ownerId,
      action: 'ITEM',
      itemId: potion.id,
      itemName: potion.name,
      resource: potion.type,
      resourceBefore: before,
      resourceAfter: after,
      recovered: after - before,
      remainingQuantity: consumed.remaining,
    });
    const resourceName = potion.type === 'HEALTH' ? '체력' : '마나';
    await battle.turnMessage?.edit({
      content: [
        TURN_SEPARATOR,
        `## 🟢 <@${ownerId}>님의 턴`,
        `### 🧪 「${potion.name}」 사용`,
        `${resourceName}를 **${after - before}** 회복했습니다. (${before} → ${after}/${max})`,
        TURN_SEPARATOR,
      ].join('\n'),
      components: [],
    });
    await interaction.update({
      content: `${potion.name}을(를) 사용했습니다. 남은 수량: ${consumed.remaining}개`,
      components: [],
    });

    await this.waitAfterBattleAction();
    if (
      !this.adventureManager.adventures.has(adventure.id) ||
      this.battles.get(adventure.id) !== battle
    ) return true;
    this.completeActorTurn(adventure, battle, actor);
    await this.resolveEnemyTurns(adventure, battle);
    if (this.adventureManager.adventures.has(adventure.id)) await this.sendBattleState(adventure, battle);
    return true;
  }

  async finishBattleVictory(adventure, battle) {
    this.battles.delete(adventure.id);
    adventure.combatsWonThisFloor = (adventure.combatsWonThisFloor ?? 0) + 1;
    const channel = this.getTextChannel(adventure);
    if (!channel) return;
    const rewardLines = [];
    const rewards = [];
    const isTreasureMimic = battle.monster.isMimic;
    for (const userId of adventure.memberIds) {
      const goldReward = isTreasureMimic
        ? adventure.floor * (Math.floor(Math.random() * 21) + 10)
        : battle.monster.goldReward;
      let equipmentDrop = null;
      if (isTreasureMimic || shouldDropEquipmentFromMonster(false)) {
        const slot = equipmentSlots[Math.floor(Math.random() * equipmentSlots.length)];
        const rarity = rollEquipmentRarity(battle.monster.level);
        equipmentDrop = createEquipment({
          name: getEquipmentName(rarity, slot),
          itemLevel: battle.monster.level,
          rarity,
          slot,
        });
      }
      await this.playerStore.addAdventureReward(
        userId,
        goldReward,
        equipmentDrop,
      );
      this.recordAdventureGold(adventure, userId, goldReward);
      if (equipmentDrop) this.recordAdventureEquipment(adventure, userId, equipmentDrop.id);
      const experienceResult = await this.playerStore.grantMonsterExperience(
        userId,
        battle.monster.level,
        battle.monster.isBoss ? 2 : 1,
      );
      if (experienceResult.levelsGained > 0) {
        const addedHealth = LEVEL_STAT_GROWTH.health * experienceResult.levelsGained;
        const addedMana = LEVEL_STAT_GROWTH.mana * experienceResult.levelsGained;
        adventure.maxHealthByUser[userId] = roundHealth(adventure.maxHealthByUser[userId] + addedHealth);
        adventure.healthByUser[userId] = roundHealth(adventure.healthByUser[userId] + addedHealth);
        adventure.manaByUser[userId] = roundMana((adventure.manaByUser[userId] ?? 0) + addedMana);
      }
      const potion = rollPotionDrop(isTreasureMimic ? 'TREASURE' : 'MONSTER');
      if (potion) await this.playerStore.addItem(userId, potion.id, 1);
      const skillFragmentRarity = rollSkillFragment(
        battle.monster.isBoss ? 'BOSS' : 'MONSTER',
      );
      if (skillFragmentRarity) await this.playerStore.addSkillFragment(userId, skillFragmentRarity, 1);
      rewards.push({
        userId,
        gold: goldReward,
        experience: experienceResult.gainedExperience,
        previousLevel: experienceResult.previousLevel,
        newLevel: experienceResult.newLevel,
        levelsGained: experienceResult.levelsGained,
        equipment: equipmentDrop,
        potion: potion ? { id: potion.id, name: potion.name } : null,
        skillFragment: skillFragmentRarity,
      });
      const levelUpText = experienceResult.levelsGained > 0
        ? [
            `, 🎉 **Lv.${experienceResult.newLevel} 달성!**`,
            `\n↳ 체력 +${LEVEL_STAT_GROWTH.health * experienceResult.levelsGained}`,
            ` · 마나 +${LEVEL_STAT_GROWTH.mana * experienceResult.levelsGained}`,
            ` · 공격력 +${LEVEL_STAT_GROWTH.attack * experienceResult.levelsGained}`,
            ` · 마법 공격력 +${LEVEL_STAT_GROWTH.magicAttack * experienceResult.levelsGained}`,
            ` · 방어력 +${LEVEL_STAT_GROWTH.defense * experienceResult.levelsGained}`,
            ` · 속도 +${LEVEL_STAT_GROWTH.speed * experienceResult.levelsGained}`,
          ].join('')
        : ` (${experienceResult.experience}/${experienceResult.requiredExperience})`;
      rewardLines.push(
        [
          `<@${userId}>: **${goldReward}골드**, **경험치 +${experienceResult.gainedExperience}**${levelUpText}${equipmentDrop ? `, ${formatEquipmentName(equipmentDrop)} (고유 Lv.${equipmentDrop.itemLevel})` : ''}${potion ? `, ${potion.name}` : ''}${skillFragmentRarity ? `, 🧩 **${skillFragmentRarity} 스킬 조각**` : ''}`,
          `🟩 경험치 ${this.createResourceBar(experienceResult.experience, experienceResult.requiredExperience, '🟩')} ${experienceResult.experience}/${experienceResult.requiredExperience}`,
        ].join('\n'),
      );
    }
    await dungeonLogger.append(adventure.id, 'BATTLE_VICTORY', {
      floor: adventure.floor,
      monster: { ...battle.monster },
      turnsTaken: battle.actionCount + 1,
      rewards,
      partyHealthAfter: { ...adventure.healthByUser },
      partyManaAfter: { ...battle.manaByUser },
    });
    const row = battle.monster.isBoss
      ? null
      : this.createButtons(adventure, [
          { action: 'continue', label: '계속 탐험', style: ButtonStyle.Primary },
        ]);
    await channel.send({
      content: [
        `# 🎉 ${battle.monster.name} 처치!`,
        isTreasureMimic ? '**보물상자 보상**' : '**전투 보상**',
        ...rewardLines,
      ].join('\n'),
      components: row ? [row] : [],
    });
    if (battle.monster.isBoss) {
      adventure.bossDefeated = true;
      await this.rewardTreasure(adventure, { showContinue: false, bossChest: true });
      if (adventure.floor >= 100) await this.askToCompleteDungeon(adventure);
      else {
        await this.saveBossCheckpointForParty(adventure);
        await this.moveToNextFloor(adventure);
      }
    }
  }

  cleanup(adventureId) {
    this.battles.delete(adventureId);
  }

  recordAdventureEquipment(adventure, userId, equipmentId) {
    adventure.acquiredEquipmentIdsByUser ??= {};
    adventure.acquiredEquipmentIdsByUser[userId] ??= [];
    adventure.acquiredEquipmentIdsByUser[userId].push(equipmentId);
  }

  recordAdventureGold(adventure, userId, gold) {
    adventure.acquiredGoldByUser ??= {};
    adventure.acquiredGoldByUser[userId] = (adventure.acquiredGoldByUser[userId] ?? 0) + Math.max(0, Math.floor(gold));
  }

  async removeDeathLoot(adventure, userId) {
    const equipmentIds = adventure.acquiredEquipmentIdsByUser?.[userId] ?? [];
    if (equipmentIds.length === 0) return [];
    adventure.acquiredEquipmentIdsByUser[userId] = [];
    return this.playerStore.removeInventoryEquipmentByIds(userId, equipmentIds);
  }

  async removeAdventureDeathRewards(adventure, userId) {
    const equipment = await this.removeDeathLoot(adventure, userId);
    const goldToRemove = adventure.acquiredGoldByUser?.[userId] ?? 0;
    adventure.acquiredGoldByUser ??= {};
    adventure.acquiredGoldByUser[userId] = 0;
    const goldResult = goldToRemove > 0
      ? await this.playerStore.removeGold(userId, goldToRemove)
      : { removed: 0 };
    return { equipment, gold: goldResult.removed };
  }

  async resolveSpecialEvent(adventure) {
    const event = rollSpecialEvent();
    if (event === 'TREASURE') {
      if (Math.random() < 0.1) {
        await this.showEnemyEncounter(adventure, true);
        return;
      }
      await this.rewardTreasure(adventure);
      return;
    }
    if (event === 'TRAP') {
      await this.triggerTrap(adventure);
      return;
    }
    await this.triggerRest(adventure);
  }

  async showSpecialDoor(adventure) {
    const channel = this.getTextChannel(adventure);
    if (!channel) return;
    const row = this.createButtons(adventure, [
      { action: 'special_enter', label: '갈까?', style: ButtonStyle.Primary },
      { action: 'special_leave', label: '돌아가기', style: ButtonStyle.Secondary },
    ]);
    const attachmentName = 'mysterious-door.png';
    const attachment = new AttachmentBuilder(path.join(eventAssetsDirectory, attachmentName));
    const embed = new EmbedBuilder()
      .setColor(0x8e44ad)
      .setTitle('🚪 신비한 문을 발견했습니다')
      .setDescription('문 너머에서 알 수 없는 기운이 흘러나옵니다. 안으로 들어가 볼까요?')
      .setImage(`attachment://${attachmentName}`);
    await dungeonLogger.append(adventure.id, 'SPECIAL_DOOR_FOUND', {
      floor: adventure.floor,
    });
    await channel.send({
      embeds: [embed],
      files: [attachment],
      components: [row],
    });
  }

  async rewardTreasure(adventure, { showContinue = true, bossChest = false } = {}) {
    const channel = this.getTextChannel(adventure);
    if (!channel) return;
    const rewardLines = [];
    const rewards = [];

    for (const userId of [...adventure.memberIds]) {
      const gold = adventure.floor * (Math.floor(Math.random() * 21) + 10);
      const slot = equipmentSlots[Math.floor(Math.random() * equipmentSlots.length)];
      const rarity = rollEquipmentRarity(adventure.floor);
      const item = createEquipment({
        name: getEquipmentName(rarity, slot),
        itemLevel: adventure.floor,
        rarity,
        slot,
      });
      await this.playerStore.addAdventureReward(userId, gold, item);
      this.recordAdventureGold(adventure, userId, gold);
      this.recordAdventureEquipment(adventure, userId, item.id);
      const potion = rollPotionDrop('TREASURE');
      if (potion) await this.playerStore.addItem(userId, potion.id, 1);
      const skillFragmentRarity = bossChest ? null : rollSkillFragment('TREASURE');
      if (skillFragmentRarity) await this.playerStore.addSkillFragment(userId, skillFragmentRarity, 1);
      rewards.push({
        userId,
        gold,
        equipment: item,
        potion: potion ? { id: potion.id, name: potion.name } : null,
        skillFragment: skillFragmentRarity,
      });
      rewardLines.push(
        `<@${userId}>: **${gold}골드**, ${formatEquipmentName(item)}${potion ? `, ${potion.name}` : ''}${skillFragmentRarity ? `, 🧩 **${skillFragmentRarity} 스킬 조각**` : ''}`,
      );
    }

    await dungeonLogger.append(adventure.id, 'TREASURE_REWARD', {
      floor: adventure.floor,
      bossChest,
      rewards,
    });

    const row = showContinue
      ? this.createButtons(adventure, [
          { action: 'continue', label: '계속 탐험', style: ButtonStyle.Primary },
        ])
      : null;
    const attachmentName = 'treasure-chest.png';
    const attachment = new AttachmentBuilder(path.join(eventAssetsDirectory, attachmentName));
    const embed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle(bossChest ? '🎁 보스 보물상자' : '🎁 보물상자를 발견했습니다!')
      .setDescription(rewardLines.join('\n'))
      .setImage(`attachment://${attachmentName}`);
    await channel.send({
      embeds: [embed],
      files: [attachment],
      components: row ? [row] : [],
    });
  }

  async saveBossCheckpointForParty(adventure) {
    const channel = this.getTextChannel(adventure);
    const checkpointFloor = getCheckpointFloorAfterBoss(adventure.floor);
    if (!channel || !checkpointFloor) return [];
    const results = await this.playerStore.unlockCheckpointForUsers(
      adventure.memberIds,
      checkpointFloor,
    );
    const unlockedFloors = getUnlockedCheckpointFloors(checkpointFloor);
    await dungeonLogger.append(adventure.id, 'CHECKPOINT_SAVED', {
      floor: adventure.floor,
      checkpointFloor,
      userIds: [...adventure.memberIds],
      results,
      automatic: true,
    });
    await channel.send({
      content: [
        `# 🚩 ${checkpointFloor}층 체크포인트 자동 저장`,
        `${adventure.memberIds.map((userId) => `<@${userId}>`).join(' ')} 파티원 전원에게 저장했습니다.`,
        `이제 모험 시작 시 **${unlockedFloors.map((floor) => `${floor}층`).join(', ')}** 중에서 선택할 수 있습니다.`,
      ].join('\n'),
    });
    return results;
  }

  async askToCompleteDungeon(adventure) {
    const channel = this.getTextChannel(adventure);
    if (!channel) return;
    const row = this.createButtons(adventure, [
      { action: 'dungeon_complete', label: '100층 던전 완주', style: ButtonStyle.Success },
    ]);
    await channel.send({
      content: [
        '# 👑 100층 던전 완주!',
        '**심연의 군주**를 쓰러뜨리고 세계의 끝에 도달했습니다.',
        '공대장이 버튼을 누르면 모험을 마치고 파티가 탑의 광장으로 돌아갑니다.',
      ].join('\n'),
      components: [row],
    });
  }

  async triggerTrap(adventure) {
    const channel = this.getTextChannel(adventure);
    if (!channel) return;
    const damageLines = [];
    for (const userId of [...adventure.memberIds]) {
      const maxHealth = adventure.maxHealthByUser[userId];
      const damage = Math.max(1, roundHealth(maxHealth * 0.1));
      const healthBefore = adventure.healthByUser[userId];
      const willDie = adventure.healthByUser[userId] - damage <= 0;
      const lostRewards = willDie
        ? await this.removeAdventureDeathRewards(adventure, userId)
        : { equipment: [], gold: 0 };
      await dungeonLogger.append(adventure.id, 'TRAP_DAMAGE', {
        floor: adventure.floor,
        userId,
        damage,
        healthBefore,
        healthAfter: roundHealth(healthBefore - damage),
        lostEquipment: lostRewards.equipment.map((item) => ({
          id: item.id,
          name: item.name,
          itemLevel: item.itemLevel,
          rarity: item.rarity,
          enhancement: item.enhancement,
        })),
        lostGold: lostRewards.gold,
      });
      const health = await this.adventureManager.damage(this.client, userId, damage);
      damageLines.push(
        `<@${userId}>: **-${damage}**, 체력 ${health ?? 0}/${maxHealth}${lostRewards.equipment.length > 0 || lostRewards.gold > 0 ? ` · ☠️ 모험 장비 ${lostRewards.equipment.length}개 · 골드 ${lostRewards.gold}G 소실` : ''}`,
      );
    }
    if (!this.adventureManager.adventures.has(adventure.id)) return;

    const row = this.createButtons(adventure, [
      { action: 'continue', label: '계속 탐험', style: ButtonStyle.Primary },
    ]);
    const attachmentName = 'spike-trap.png';
    const attachment = new AttachmentBuilder(path.join(eventAssetsDirectory, attachmentName));
    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('🪤 함정을 밟았습니다!')
      .setDescription(damageLines.join('\n'))
      .setImage(`attachment://${attachmentName}`);
    await channel.send({
      embeds: [embed],
      files: [attachment],
      components: [row],
    });
  }

  async triggerRest(adventure) {
    const channel = this.getTextChannel(adventure);
    if (!channel) return;
    const recoveries = [];
    const recoveryLines = adventure.memberIds.map((userId) => {
      const result = this.adventureManager.healMissingHealth(userId, 0.5);
      recoveries.push({ userId, ...result });
      return `<@${userId}>: **+${result.recovered}**, 체력 ${result.after}/${result.max}`;
    });
    await dungeonLogger.append(adventure.id, 'REST', {
      floor: adventure.floor,
      recoveries,
    });
    const row = this.createButtons(adventure, [
      { action: 'continue', label: '계속 탐험', style: ButtonStyle.Primary },
    ]);
    const attachmentName = 'rest-area.png';
    const attachment = new AttachmentBuilder(path.join(eventAssetsDirectory, attachmentName));
    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('🏕️ 휴식 공간을 발견했습니다!')
      .setDescription(`잃은 체력의 50%를 회복합니다.\n${recoveryLines.join('\n')}`)
      .setImage(`attachment://${attachmentName}`);
    await channel.send({
      embeds: [embed],
      files: [attachment],
      components: [row],
    });
  }

  async moveToNextFloor(adventure, sourceTextChannel = null) {
    const previousFloor = adventure.floor;
    adventure.floor += 1;
    adventure.stairsAvailable = false;
    adventure.bossDefeated = false;
    adventure.combatsWonThisFloor = 0;
    adventure.currentActionToken = null;
    this.battles.delete(adventure.id);
    await this.playerStore.recordMaxReachedFloor(adventure.memberIds, adventure.floor);
    await dungeonLogger.append(adventure.id, 'FLOOR_CHANGED', {
      floor: adventure.floor,
      fromFloor: previousFloor,
      toFloor: adventure.floor,
      method: 'STAIRS_OR_BOSS_CLEAR',
    });
    const guild = this.client.guilds.cache.get(adventure.guildId);
    if (!guild) throw new Error(`길드를 찾을 수 없습니다: ${adventure.guildId}`);
    const textChannel = sourceTextChannel
      ?? guild.channels.cache.get(adventure.textChannelId)
      ?? await guild.channels.fetch(adventure.textChannelId).catch(() => null);
    if (!textChannel) throw new Error(`모험 텍스트 채널을 찾을 수 없습니다: ${adventure.textChannelId}`);
    await textChannel.send(`# 🪜 ${adventure.floor}층에 도착했습니다!`);
    await this.continueAfterFloorChange(adventure, textChannel);
  }

  async moveToFloor(adventure, floor, sourceTextChannel = null) {
    const previousFloor = adventure.floor;
    adventure.floor = Math.max(1, floor);
    adventure.stairsAvailable = false;
    adventure.bossDefeated = false;
    adventure.combatsWonThisFloor = 0;
    adventure.currentActionToken = null;
    this.battles.delete(adventure.id);
    await this.playerStore.recordMaxReachedFloor(adventure.memberIds, adventure.floor);
    await dungeonLogger.append(adventure.id, 'FLOOR_CHANGED', {
      floor: adventure.floor,
      fromFloor: previousFloor,
      toFloor: adventure.floor,
      method: 'CHECKPOINT',
    });
    const guild = this.client.guilds.cache.get(adventure.guildId);
    if (!guild) throw new Error(`길드를 찾을 수 없습니다: ${adventure.guildId}`);
    const textChannel = sourceTextChannel
      ?? guild.channels.cache.get(adventure.textChannelId)
      ?? await guild.channels.fetch(adventure.textChannelId).catch(() => null);
    if (!textChannel) throw new Error(`모험 텍스트 채널을 찾을 수 없습니다: ${adventure.textChannelId}`);
    await textChannel.send(`# 🚩 체크포인트를 사용해 ${adventure.floor}층에 도착했습니다!`);
    await this.continueAfterFloorChange(adventure, textChannel);
  }

  async continueAfterFloorChange(adventure, textChannel) {
    try {
      await this.beginNextStep(adventure);
    } catch (error) {
      console.error(`${adventure.floor}층 탐험 시작에 실패했습니다.`, error);
      if (!this.adventureManager.adventures.has(adventure.id) || !textChannel) return;
      const row = this.createButtons(adventure, [
        { action: 'continue', label: '탐험 재개', style: ButtonStyle.Primary },
      ]);
      await textChannel.send({
        content: '⚠️ 다음 탐험 이벤트를 불러오지 못했습니다. 공대장이 버튼을 눌러 다시 진행해 주세요.',
        components: [row],
      });
    }
  }

  async handleCheckpointSelect(interaction) {
    if (!interaction.customId.startsWith('checkpoint_select:')) return false;
    const [, adventureId, token] = interaction.customId.split(':');
    const adventure = this.adventureManager.adventures.get(adventureId);
    if (!adventure || interaction.channelId !== adventure.textChannelId) {
      await interaction.reply({ content: '이미 종료된 모험입니다.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (interaction.user.id !== adventure.leaderId) {
      await interaction.reply({ content: '체크포인트 시작 층은 공대장만 선택할 수 있습니다.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (token !== adventure.currentActionToken) {
      await interaction.reply({ content: '이미 처리된 체크포인트 선택입니다.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const selectedFloor = Number(interaction.values[0]);
    const availableFloors = adventure.availableCheckpointFloors ?? [1];
    if (!availableFloors.includes(selectedFloor)) {
      await interaction.reply({ content: '해금하지 않은 체크포인트입니다.', flags: MessageFlags.Ephemeral });
      return true;
    }

    adventure.currentActionToken = null;
    await dungeonLogger.append(adventure.id, 'CHECKPOINT_SELECTED', {
      floor: adventure.floor,
      userId: interaction.user.id,
      selectedFloor,
      availableFloors,
    });
    await interaction.update({
      content: `🚩 <@${adventure.leaderId}>님이 **${selectedFloor}층** 시작을 선택했습니다.`,
      components: [],
    });
    if (selectedFloor === 1) await this.beginNextStep(adventure);
    else await this.moveToFloor(adventure, selectedFloor, interaction.channel);
    return true;
  }

  async handleButton(interaction) {
    if (!interaction.customId.startsWith('dungeon:')) return false;
    const [, adventureId, token, action, ownerId] = interaction.customId.split(':');
    const adventure = this.adventureManager.adventures.get(adventureId);
    if (!adventure || interaction.channelId !== adventure.textChannelId) {
      await interaction.reply({ content: '이미 종료된 모험입니다.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!adventure.memberIds.includes(interaction.user.id)) {
      await interaction.reply({ content: '현재 공대원만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (ownerId && ownerId !== 'any' && interaction.user.id !== ownerId) {
      await interaction.reply({
        content: `이 행동 버튼은 현재 턴인 <@${ownerId}>님만 사용할 수 있습니다.`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const battleActions = ['battle_attack', 'battle_skill', 'battle_item'];
    const isBattleAction = battleActions.includes(action);
    if (!isBattleAction && interaction.user.id !== adventure.leaderId) {
      await interaction.reply({ content: '탐험 진행은 공대장만 선택할 수 있습니다.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (token !== adventure.currentActionToken) {
      await interaction.reply({ content: '이미 처리된 선택입니다.', flags: MessageFlags.Ephemeral });
      return true;
    }

    if (isBattleAction) {
      await this.handleBattleAction(interaction, adventure, action);
      return true;
    }

    adventure.currentActionToken = null;
    await dungeonLogger.append(adventure.id, 'PARTY_CHOICE', {
      floor: adventure.floor,
      userId: interaction.user.id,
      action,
    });
    if (action === 'stairs_yes') {
      await interaction.update({
        content: `🪜 **${adventure.floor + 1}층으로 이동 중입니다...**`,
        components: [],
      });
    } else if (action === 'special_enter') {
      await interaction.update({
        content: [
          '# 🚶 신비한 문으로 걸어갑니다...',
          '희미한 빛을 따라 조심스럽게 문 너머로 들어갑니다.',
        ].join('\n'),
        components: [],
      });
    } else {
      await interaction.update({ components: [] });
    }
    if (action === 'dungeon_complete') {
      this.cleanup(adventure.id);
      await this.adventureManager.end(this.client, adventure.id, 'DUNGEON_CLEARED');
    }
    if (action === 'stairs_yes') await this.moveToNextFloor(adventure, interaction.channel);
    if (action === 'stairs_no') {
      adventure.stairsAvailable = false;
      await this.resolveExplorationRoll(adventure, false);
    }
    if (action === 'special_enter') {
      await this.waitAfterBattleAction();
      if (this.adventureManager.adventures.has(adventure.id)) {
        await this.resolveSpecialEvent(adventure);
      }
    }
    if (action === 'special_leave') await this.resolveExplorationRoll(adventure, false);
    if (action === 'continue') await this.beginNextStep(adventure);
    return true;
  }
}

export { AdventureSystem };
