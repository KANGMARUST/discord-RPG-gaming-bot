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
import { calculateSkillHealing, getSkill } from './skills.js';
import { getDungeonRegion } from './monster-catalog.js';
import { dungeonLogger } from './dungeon-logger.js';
import { roundHealth } from './adventure-manager.js';

const TURN_SEPARATOR = '# ============================================================';
const BATTLE_ACTION_DELAY_MS = 1_000;
const RESOURCE_BAR_SEGMENTS = 10;
const HEALTH_BAR_FILLED = '🟥';
const MANA_BAR_FILLED = '🟦';
const RESOURCE_BAR_EMPTY = '⬛';
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const monsterAssetsDirectory = path.join(currentDirectory, '..', 'assets', 'monsters');
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

  createMonsterTurnVisual(monster) {
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
      .setDescription(`「${monster.skillName}」을(를) 시전합니다.`)
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
    const players = {};
    for (const userId of adventure.memberIds) {
      const player = await this.playerStore.getOrCreate(userId);
      players[userId] = {
        playerLevel: player.stats.playerLevel,
        experience: player.experience,
        totalStats: calculateTotalStats(player),
        equipment: structuredClone(player.equipment),
        equippedSkills: [...player.equippedSkills],
      };
    }
    await dungeonLogger.start(adventure, players);
    const leader = await this.playerStore.getOrCreate(adventure.leaderId);
    if (leader.checkpointFloor > 1) {
      adventure.pendingCheckpointFloor = leader.checkpointFloor;
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
    const floor = adventure.pendingCheckpointFloor;
    const row = this.createButtons(adventure, [
      { action: 'checkpoint_yes', label: `${floor}층에서 시작`, style: ButtonStyle.Success },
      { action: 'checkpoint_no', label: '1층에서 시작', style: ButtonStyle.Secondary },
    ]);
    await channel.send({
      content: `🚩 공대장에게 **${floor}층 체크포인트**가 있습니다. 파티 전체가 체크포인트로 이동할까요?`,
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
    await channel.send({
      content: `🪜 **${adventure.floor + 1}층으로 향하는 계단**이 있습니다. 다음 층으로 가겠습니까?`,
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
      await this.resolveSpecialEvent(adventure);
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
      skillName: isMimic ? '탐욕의 이빨' : isBoss ? region.boss.skillName : region.normal.skillName,
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
    const manaByUser = {};
    for (const userId of adventure.memberIds) {
      const player = await this.playerStore.getOrCreate(userId);
      playerStats[userId] = calculateTotalStats(player);
      manaByUser[userId] = playerStats[userId].mana;
    }

    const monster = this.createMonster(adventure.floor, isMimic, adventure.memberIds.length, isBoss);
    const actors = [
      ...adventure.memberIds.map((userId) => ({
        key: `PLAYER:${userId}`,
        type: 'PLAYER',
        userId,
        speed: playerStats[userId].speed,
        nextActionAt: this.getBaseActionValue(playerStats[userId].speed),
      })),
      {
        key: 'ENEMY',
        type: 'ENEMY',
        speed: monster.speed,
        nextActionAt: this.getBaseActionValue(monster.speed),
      },
    ];

    const battle = {
      adventureId: adventure.id,
      monster,
      playerStats,
      manaByUser,
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
    actor.nextActionAt += this.getBaseActionValue(actor.speed);
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

  async resolveEnemyTurns(adventure, battle) {
    let actor = this.getCurrentActor(adventure, battle);
    while (actor?.type === 'ENEMY' && adventure.memberIds.length > 0) {
      const targets = adventure.memberIds.filter(
        (userId) => (adventure.healthByUser[userId] ?? 0) > 0,
      );
      if (targets.length === 0) return;
      const targetId = targets[Math.floor(Math.random() * targets.length)];
      const targetStats = battle.playerStats[targetId];
      const result = this.calculateDamage(
        battle.monster.attack,
        targetStats.defense,
        battle.monster.level,
        battle.monster.criticalChance,
        battle.monster.criticalDamage,
      );
      if (result.damage > 0) battle.partyHasTakenDamage = true;
      const expectedHealth = roundHealth(adventure.healthByUser[targetId] - result.damage);
      const lostEquipment = expectedHealth === 0
        ? await this.removeDeathLoot(adventure, targetId)
        : [];
      const channel = this.getTextChannel(adventure);
      const visual = this.createMonsterTurnVisual(battle.monster);
      await dungeonLogger.append(adventure.id, 'TURN_ACTION', {
        floor: adventure.floor,
        turn: battle.actionCount + 1,
        actorType: 'ENEMY',
        actorId: 'ENEMY',
        actorName: battle.monster.name,
        action: battle.monster.skillName,
        targetId,
        damage: result.damage,
        critical: result.critical,
        targetHealthBefore: adventure.healthByUser[targetId],
        targetHealthAfter: expectedHealth,
        lostEquipment: lostEquipment.map((item) => ({
          id: item.id,
          name: item.name,
          itemLevel: item.itemLevel,
          rarity: item.rarity,
          enhancement: item.enhancement,
        })),
      });
      await channel?.send({
        content: [
          TURN_SEPARATOR,
          `## 🔴 ${battle.monster.name}의 턴`,
          `### 👹 「${battle.monster.skillName}」 시전`,
          `# 💥 ${result.damage} 피해${result.critical ? ' · 치명타!' : ''}`,
          `<@${targetId}> 공격받음`,
          `남은 체력: **${expectedHealth}/${adventure.maxHealthByUser[targetId]}**`,
          lostEquipment.length > 0
            ? `☠️ 사망하여 이번 모험에서 획득한 장비 **${lostEquipment.length}개**를 잃었습니다.`
            : null,
          TURN_SEPARATOR,
        ].filter(Boolean).join('\n'),
        embeds: [visual.embed],
        files: [visual.attachment],
      });
      const health = await this.adventureManager.damage(this.client, targetId, result.damage);
      if (!this.adventureManager.adventures.has(adventure.id)) {
        this.cleanup(adventure.id);
        return;
      }
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
        const stats = battle.playerStats[userId];
        const health = adventure.healthByUser[userId];
        const maxHealth = adventure.maxHealthByUser[userId];
        const mana = battle.manaByUser[userId];
        return [
          `<@${userId}> · Lv.${stats.playerLevel}`,
          `❤️ 체력 ${health}/${maxHealth} ${this.createResourceBar(health, maxHealth, HEALTH_BAR_FILLED)}`,
          `🔷 마나 ${mana}/${stats.mana} ${this.createResourceBar(mana, stats.mana, MANA_BAR_FILLED)}`,
          `⚔️ 공격력 ${stats.attack}\t✨ 마법 공격력 ${stats.magicAttack}`,
          `🎯 치명타 확률 ${stats.criticalChance}%\t💥 치명타 피해 ${stats.criticalDamage}%`,
        ].join('\n');
      })
      .join('\n');
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
    const actor = this.getCurrentActor(adventure, battle);
    if (!channel || actor?.type !== 'PLAYER') return;
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
            .setStyle(ButtonStyle.Primary),
        ),
      );
      await interaction.reply({
        content: '이번 턴에 시전할 스킬을 선택하세요.',
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const stats = battle.playerStats[actor.userId];
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
              .setStyle(ButtonStyle.Success);
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
      !skill
    ) {
      await interaction.reply({ content: '이미 지나간 턴이거나 올바르지 않은 대상입니다.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (battle.manaByUser[ownerId] < skill.manaCost) {
      await interaction.reply({ content: '스킬 시전에 필요한 마나가 부족합니다.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const before = adventure.healthByUser[targetId];
    const maxHealth = adventure.maxHealthByUser[targetId];
    if (before >= maxHealth) {
      await interaction.reply({ content: '대상의 체력이 이미 최대입니다.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const healing = calculateSkillHealing(skill, battle.playerStats[ownerId].magicAttack);
    const after = roundHealth(Math.min(maxHealth, before + healing));
    const manaBefore = battle.manaByUser[ownerId];
    adventure.healthByUser[targetId] = after;
    battle.manaByUser[ownerId] -= skill.manaCost;
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
      after = Math.min(max, before + Math.max(1, Math.round(max * potion.recoveryRatio)));
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
    for (const userId of adventure.memberIds) {
      let equipmentDrop = null;
      if (shouldDropEquipmentFromMonster(battle.monster.isMimic)) {
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
        battle.monster.goldReward,
        equipmentDrop,
      );
      if (equipmentDrop) this.recordAdventureEquipment(adventure, userId, equipmentDrop.id);
      const experienceResult = await this.playerStore.grantMonsterExperience(
        userId,
        battle.monster.level,
        battle.monster.isBoss ? 2 : 1,
      );
      if (experienceResult.levelsGained > 0) {
        const addedHealth = LEVEL_STAT_GROWTH.health * experienceResult.levelsGained;
        adventure.maxHealthByUser[userId] = roundHealth(adventure.maxHealthByUser[userId] + addedHealth);
        adventure.healthByUser[userId] = roundHealth(adventure.healthByUser[userId] + addedHealth);
      }
      const potion = rollPotionDrop('MONSTER');
      if (potion) await this.playerStore.addItem(userId, potion.id, 1);
      rewards.push({
        userId,
        gold: battle.monster.goldReward,
        experience: experienceResult.gainedExperience,
        previousLevel: experienceResult.previousLevel,
        newLevel: experienceResult.newLevel,
        levelsGained: experienceResult.levelsGained,
        equipment: equipmentDrop,
        potion: potion ? { id: potion.id, name: potion.name } : null,
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
        `<@${userId}>: **${battle.monster.goldReward}골드**, **경험치 +${experienceResult.gainedExperience}**${levelUpText}${equipmentDrop ? `, ${formatEquipmentName(equipmentDrop)} (고유 Lv.${equipmentDrop.itemLevel})` : ''}${potion ? `, ${potion.name}` : ''}`,
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
        '**전투 보상**',
        ...rewardLines,
      ].join('\n'),
      components: row ? [row] : [],
    });
    if (battle.monster.isBoss) {
      adventure.bossDefeated = true;
      await this.rewardTreasure(adventure, { showContinue: false, bossChest: true });
      if (adventure.floor >= 100) await this.askToCompleteDungeon(adventure);
      else await this.askToSaveBossCheckpoint(adventure);
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

  async removeDeathLoot(adventure, userId) {
    const equipmentIds = adventure.acquiredEquipmentIdsByUser?.[userId] ?? [];
    if (equipmentIds.length === 0) return [];
    adventure.acquiredEquipmentIdsByUser[userId] = [];
    return this.playerStore.removeInventoryEquipmentByIds(userId, equipmentIds);
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
      this.recordAdventureEquipment(adventure, userId, item.id);
      const potion = rollPotionDrop('TREASURE');
      if (potion) await this.playerStore.addItem(userId, potion.id, 1);
      rewards.push({
        userId,
        gold,
        equipment: item,
        potion: potion ? { id: potion.id, name: potion.name } : null,
      });
      rewardLines.push(
        `<@${userId}>: **${gold}골드**, ${formatEquipmentName(item)}${potion ? `, ${potion.name}` : ''}`,
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
    await channel.send({
      content: `${bossChest ? '# 🎁 보스 보물상자!' : '🎁 보물상자를 발견했습니다!'}\n${rewardLines.join('\n')}`,
      components: row ? [row] : [],
    });
  }

  async askToSaveBossCheckpoint(adventure) {
    const channel = this.getTextChannel(adventure);
    if (!channel) return;
    const nextFloor = adventure.floor + 1;
    const row = this.createButtons(adventure, [
      { action: 'boss_checkpoint_yes', label: `체크포인트 저장 (${nextFloor}층)`, style: ButtonStyle.Success },
      { action: 'boss_checkpoint_no', label: '저장하지 않고 이동', style: ButtonStyle.Secondary },
    ]);
    await channel.send({
      content: `🚩 보스를 처치해 **${nextFloor}층 체크포인트**를 기록할 수 있습니다. 공대장이 저장할까요?`,
      components: [row],
    });
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
      const lostEquipment = willDie ? await this.removeDeathLoot(adventure, userId) : [];
      await dungeonLogger.append(adventure.id, 'TRAP_DAMAGE', {
        floor: adventure.floor,
        userId,
        damage,
        healthBefore,
        healthAfter: roundHealth(healthBefore - damage),
        lostEquipment: lostEquipment.map((item) => ({
          id: item.id,
          name: item.name,
          itemLevel: item.itemLevel,
          rarity: item.rarity,
          enhancement: item.enhancement,
        })),
      });
      const health = await this.adventureManager.damage(this.client, userId, damage);
      damageLines.push(
        `<@${userId}>: **-${damage}**, 체력 ${health ?? 0}/${maxHealth}${lostEquipment.length > 0 ? ` · ☠️ 모험 장비 ${lostEquipment.length}개 소실` : ''}`,
      );
    }
    if (!this.adventureManager.adventures.has(adventure.id)) return;

    const row = this.createButtons(adventure, [
      { action: 'continue', label: '계속 탐험', style: ButtonStyle.Primary },
    ]);
    await channel.send({
      content: `🪤 함정을 밟았습니다!\n${damageLines.join('\n')}`,
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
    await channel.send({
      content: `🏕️ 휴식 공간을 발견했습니다! 잃은 체력의 50%를 회복합니다.\n${recoveryLines.join('\n')}`,
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
    } else {
      await interaction.update({ components: [] });
    }
    if (action === 'checkpoint_yes') {
      const floor = adventure.pendingCheckpointFloor;
      adventure.pendingCheckpointFloor = null;
      await this.moveToFloor(adventure, floor, interaction.channel);
    }
    if (action === 'checkpoint_no') {
      adventure.pendingCheckpointFloor = null;
      await this.beginNextStep(adventure);
    }
    if (action === 'boss_checkpoint_yes') {
      const result = await this.playerStore.unlockCheckpoint(
        adventure.leaderId,
        adventure.floor + 1,
      );
      await dungeonLogger.append(adventure.id, 'CHECKPOINT_SAVED', {
        floor: adventure.floor,
        userId: adventure.leaderId,
        checkpointFloor: result.checkpointFloor,
      });
      await this.getTextChannel(adventure)?.send(
        `🚩 공대장 <@${adventure.leaderId}>님의 체크포인트를 **${result.checkpointFloor}층**으로 저장했습니다.`,
      );
      await this.moveToNextFloor(adventure);
    }
    if (action === 'boss_checkpoint_no') await this.moveToNextFloor(adventure);
    if (action === 'dungeon_complete') {
      this.cleanup(adventure.id);
      await this.adventureManager.end(this.client, adventure.id, 'DUNGEON_CLEARED');
    }
    if (action === 'stairs_yes') await this.moveToNextFloor(adventure, interaction.channel);
    if (action === 'stairs_no') {
      adventure.stairsAvailable = false;
      await this.resolveExplorationRoll(adventure, false);
    }
    if (action === 'continue') await this.beginNextStep(adventure);
    return true;
  }
}

export { AdventureSystem };
