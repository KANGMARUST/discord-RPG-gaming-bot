import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { calculateTotalStats } from './equipment.js';
import {
  calculateSkillPower,
  getSkill,
  getSkillCostText,
  getSkillManaCost,
} from './skills.js';

const PVP_CATEGORY_NAME = 'PVP';
const PLAZA_CATEGORY_NAME = '탑';
const PLAZA_CHANNEL_NAME = '광장';
const TURN_SEPARATOR = '# ============================================================';
const RESOURCE_BAR_SEGMENTS = 10;
const waitAfterAction = () => new Promise((resolve) => setTimeout(resolve, 1_000));
const roundHealth = (value) => Math.round(value * 10) / 10;
const roundMana = (value) => Math.round(value * 10) / 10;
const roundStat = (value) => Math.round(value * 10) / 10;

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const sumBy = (items, selector) => items.reduce((total, item) => total + Number(selector(item) ?? 0), 0);

function calculateEffectiveStats(baseStats, buffs = [], debuffs = []) {
  const affectedBy = (buff, stat) => buff.affectedStats?.includes(stat);
  const attackFlat = sumBy(buffs, (buff) =>
    buff.type === 'ATTACK_BUFF' && buff.buffMode === 'FLAT' && affectedBy(buff, 'attack') ? buff.amount : 0);
  const magicAttackFlat = sumBy(buffs, (buff) =>
    buff.type === 'ATTACK_BUFF' && buff.buffMode === 'FLAT' && affectedBy(buff, 'magicAttack') ? buff.amount : 0);
  const attackPercent = sumBy(buffs, (buff) =>
    buff.type === 'ATTACK_BUFF' && buff.buffMode === 'PERCENT' && affectedBy(buff, 'attack') ? buff.buffPercent : 0);
  const magicAttackPercent = sumBy(buffs, (buff) =>
    buff.type === 'ATTACK_BUFF' && buff.buffMode === 'PERCENT' && affectedBy(buff, 'magicAttack') ? buff.buffPercent : 0);
  const defenseFlat = sumBy(buffs, (buff) => buff.type === 'DEFENSE_BUFF' ? buff.amount : 0);
  const versatilePercent = (stat) => sumBy(
    buffs,
    (buff) => buff.type === 'VERSATILE_BUFF' ? buff.statPercentModifiers?.[stat] : 0,
  );
  const speedIncrease = clamp(
    sumBy(buffs, (buff) => buff.type === 'SPEED_BUFF' ? buff.speedIncreasePercent : 0) + versatilePercent('speed'),
    0,
    100,
  );
  const damageReduction = clamp(sumBy(buffs, (buff) => buff.damageReductionPercent), 0, 80);
  const criticalChanceIncrease = sumBy(
    buffs,
    (buff) => buff.type === 'CRITICAL_BUFF' ? buff.criticalChanceIncrease : 0,
  );

  const attackReduction = clamp(sumBy(debuffs, (debuff) => debuff.modifiers?.attackReductionPercent), 0, 80);
  const defenseReduction = clamp(sumBy(debuffs, (debuff) => debuff.modifiers?.defenseReductionPercent), 0, 80);
  const magicDefenseReduction = clamp(sumBy(debuffs, (debuff) => debuff.modifiers?.magicDefenseReductionPercent), 0, 80);
  const speedReduction = clamp(sumBy(debuffs, (debuff) => debuff.modifiers?.speedReductionPercent), 0, 50);
  const damageTakenIncrease = clamp(sumBy(debuffs, (debuff) => debuff.modifiers?.damageTakenIncreasePercent), 0, 100);

  const baseDefense = Math.max(0, Number(baseStats.defense ?? 0));
  const baseMagicDefense = Math.max(0, Number(baseStats.magicDefense ?? baseDefense));
  return {
    ...baseStats,
    attack: roundStat(
      (Math.max(0, Number(baseStats.attack ?? 0)) + attackFlat)
      * (1 + (attackPercent + versatilePercent('attack')) / 100)
      * (1 - attackReduction / 100),
    ),
    magicAttack: roundStat(
      (Math.max(0, Number(baseStats.magicAttack ?? 0)) + magicAttackFlat)
      * (1 + (magicAttackPercent + versatilePercent('magicAttack')) / 100)
      * (1 - attackReduction / 100),
    ),
    defense: roundStat(
      (baseDefense + defenseFlat)
      * (1 + versatilePercent('defense') / 100)
      * (1 - defenseReduction / 100),
    ),
    // 플레이어에게 별도 마법 방어력이 없으면 기존 PVP처럼 방어력을 기준으로 삼는다.
    magicDefense: roundStat(
      (baseMagicDefense + defenseFlat)
      * (1 + versatilePercent('defense') / 100)
      * (1 - magicDefenseReduction / 100),
    ),
    speed: roundStat(
      Math.max(1, Number(baseStats.speed ?? 1))
      * (1 + speedIncrease / 100)
      * (1 - speedReduction / 100),
    ),
    damageReductionPercent: damageReduction,
    damageTakenIncreasePercent: damageTakenIncrease,
    criticalChance: roundStat(Number(baseStats.criticalChance ?? 0) + criticalChanceIncrease),
  };
}

function calculateHealingAmount(skill, stats, currentHealth) {
  if (skill.missingHealthCoefficient) {
    return Math.max(1, Math.round(
      Math.max(0, stats.health - currentHealth) * skill.missingHealthCoefficient,
    ));
  }
  if (skill.maxHealthCoefficient) {
    return Math.max(1, Math.round(stats.health * skill.maxHealthCoefficient));
  }
  return calculateSkillPower(skill, stats);
}

function calculateRegenAmount(skill, stats) {
  if (skill.maxHealthCoefficient) {
    return Math.max(1, Math.round(stats.health * skill.maxHealthCoefficient));
  }
  return calculateSkillPower(skill, stats);
}

function calculateShieldAmount(skill, stats) {
  if (skill.shieldMaxHealthCoefficient) {
    return Math.max(1, Math.round(stats.health * skill.shieldMaxHealthCoefficient));
  }
  if (skill.maxHealthCoefficient) {
    return Math.max(1, Math.round(stats.health * skill.maxHealthCoefficient));
  }
  if (skill.shieldCoefficient) {
    return Math.max(1, Math.round(stats.magicAttack * skill.shieldCoefficient));
  }
  return calculateSkillPower(skill, stats);
}

function calculateDamageHit({
  power,
  defense,
  attackerLevel,
  criticalChance,
  criticalDamage,
  damageReductionPercent = 0,
  damageTakenIncreasePercent = 0,
  executeMultiplier = 1,
  random = Math.random,
}) {
  const levelDefenseBase = 200 + 10 * Math.max(1, attackerLevel);
  const defenseMultiplier = levelDefenseBase / (Math.max(0, defense) + levelDefenseBase);
  const critical = random() * 100 < criticalChance;
  const variance = 0.9 + random() * 0.2;
  const criticalMultiplier = critical ? criticalDamage / 100 : 1;
  const finalMultiplier = (1 - clamp(damageReductionPercent, 0, 80) / 100)
    * (1 + clamp(damageTakenIncreasePercent, 0, 100) / 100)
    * Math.max(1, executeMultiplier);
  return {
    damage: Math.max(1, Math.round(
      Math.max(1, power * defenseMultiplier)
      * variance
      * criticalMultiplier
      * finalMultiplier,
    )),
    critical,
  };
}

function consumeIncomingDamage({ health, shields, buffs, damage }) {
  let remainingDamage = Math.max(0, Math.round(damage));
  let absorbedByShield = 0;
  const nextShields = shields.map((shield) => ({ ...shield }));
  for (const shield of nextShields) {
    if (remainingDamage <= 0) break;
    const absorbed = Math.min(shield.amount, remainingDamage);
    shield.amount = roundHealth(shield.amount - absorbed);
    remainingDamage -= absorbed;
    absorbedByShield += absorbed;
  }

  const nextBuffs = buffs.map((buff) => ({ ...buff }));
  let healthAfter = roundHealth(Math.max(0, health - remainingDamage));
  let lethalGuardTriggered = false;
  if (health > 0 && healthAfter <= 0) {
    const guard = nextBuffs.find((buff) => (buff.lethalGuardCharges ?? 0) > 0);
    if (guard) {
      guard.lethalGuardCharges -= 1;
      healthAfter = 1;
      lethalGuardTriggered = true;
    }
  }

  return {
    healthAfter,
    healthDamage: roundHealth(Math.max(0, health - healthAfter)),
    absorbedByShield: roundHealth(absorbedByShield),
    shields: nextShields.filter((shield) => shield.amount > 0),
    buffs: nextBuffs,
    lethalGuardTriggered,
  };
}

function getShieldTotal(shields = []) {
  return roundHealth(sumBy(shields, (shield) => shield.amount));
}

function formatBuff(buff) {
  if (buff.type === 'ATTACK_BUFF') {
    const amount = buff.buffMode === 'PERCENT' ? `${buff.buffPercent}%` : `${buff.amount}`;
    const stats = (buff.affectedStats ?? ['attack', 'magicAttack'])
      .map((stat) => ({ attack: '공격', magicAttack: '마공' })[stat] ?? stat)
      .join('·');
    return `${buff.name}(${stats} +${amount}, ${buff.remainingTurns}턴)`;
  }
  if (buff.type === 'DEFENSE_BUFF') return `${buff.name}(방어 +${buff.amount}, ${buff.remainingTurns}턴)`;
  if (buff.type === 'DAMAGE_REDUCTION_BUFF') return `${buff.name}(받는 피해 -${buff.damageReductionPercent}%, ${buff.remainingTurns}턴)`;
  if (buff.type === 'SPEED_BUFF') return `${buff.name}(속도 +${buff.speedIncreasePercent}%, ${buff.remainingTurns}턴)`;
  if (buff.type === 'CRITICAL_BUFF') return `${buff.name}(치확 +${buff.criticalChanceIncrease}%, ${buff.remainingTurns}턴)`;
  if (buff.type === 'VERSATILE_BUFF') {
    const stats = Object.entries(buff.statPercentModifiers ?? {})
      .map(([stat, value]) => `${({ attack: '공격', magicAttack: '마공', defense: '방어', speed: '속도' })[stat] ?? stat} +${value}%`)
      .join('·');
    return `${buff.name}(${stats}, ${buff.remainingTurns}턴)`;
  }
  if (buff.type === 'REGEN') return `${buff.name}(턴 시작 체력 +${buff.amount}, ${buff.remainingTurns}회)`;
  if (buff.type === 'UNYIELDING') {
    return `${buff.name}(받는 피해 -${buff.damageReductionPercent}% · 불굴 ${buff.lethalGuardCharges}회, ${buff.remainingTurns}턴)`;
  }
  return `${buff.name}(${buff.remainingTurns}턴)`;
}

function formatDebuff(debuff) {
  const modifiers = debuff.modifiers ?? {};
  const effects = [];
  if (modifiers.attackReductionPercent) effects.push(`공격·마공 -${modifiers.attackReductionPercent}%`);
  if (modifiers.defenseReductionPercent) effects.push(`방어 -${modifiers.defenseReductionPercent}%`);
  if (modifiers.magicDefenseReductionPercent) effects.push(`마방 -${modifiers.magicDefenseReductionPercent}%`);
  if (modifiers.speedReductionPercent) effects.push(`속도 -${modifiers.speedReductionPercent}%`);
  if (modifiers.damageTakenIncreasePercent) effects.push(`받피 +${modifiers.damageTakenIncreasePercent}%`);
  return `${debuff.name}(${effects.join(' · ')}, ${debuff.remainingTurns}턴)`;
}

function createOverwrites(guild, members, voice) {
  const memberAllow = voice
    ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.Stream]
    : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
  return [
    {
      id: guild.roles.everyone.id,
      deny: voice
        ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
        : [PermissionFlagsBits.ViewChannel],
    },
    ...members.map((member) => ({ id: member.id, allow: memberAllow })),
    {
      id: guild.members.me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.MoveMembers,
      ],
    },
  ];
}

class PvpManager {
  constructor() {
    this.sessions = new Map();
    this.userSessions = new Map();
  }

  getByUser(userId) {
    const sessionId = this.userSessions.get(userId);
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  getBuffs(battle, userId) {
    battle.buffsByUser ??= {};
    battle.buffsByUser[userId] ??= [];
    return battle.buffsByUser[userId];
  }

  getDebuffs(battle, userId) {
    battle.debuffsByUser ??= {};
    battle.debuffsByUser[userId] ??= [];
    return battle.debuffsByUser[userId];
  }

  getShields(battle, userId) {
    battle.shieldsByUser ??= {};
    battle.shieldsByUser[userId] ??= [];
    return battle.shieldsByUser[userId];
  }

  getEffectiveStats(battle, userId) {
    return calculateEffectiveStats(
      battle.stats[userId],
      this.getBuffs(battle, userId),
      this.getDebuffs(battle, userId),
    );
  }

  getCooldown(battle, userId, skillId) {
    return Math.max(0, battle.cooldownsByUser?.[userId]?.[skillId] ?? 0);
  }

  hasUsedOnceSkill(battle, userId, skillId) {
    return battle.oncePerBattleByUser?.[userId]?.includes(skillId) ?? false;
  }

  getSkillUnavailableReason(battle, userId, skill) {
    if (skill.oncePerBattle && this.hasUsedOnceSkill(battle, userId, skill.id)) {
      return '이 스킬은 이번 결투에서 이미 사용했습니다.';
    }
    const cooldown = this.getCooldown(battle, userId, skill.id);
    if (cooldown > 0) return `이 스킬은 재사용 대기 중입니다. (${cooldown}턴 남음)`;
    return null;
  }

  markSkillUsed(battle, userId, skill) {
    if (skill.cooldownTurns) battle.cooldownsByUser[userId][skill.id] = skill.cooldownTurns;
    if (skill.oncePerBattle && !battle.oncePerBattleByUser[userId].includes(skill.id)) {
      battle.oncePerBattleByUser[userId].push(skill.id);
    }
  }

  rescaleActionValue(battle, userId, oldSpeed, newSpeed) {
    if (!battle.actionValue || battle.actionValue[userId] === undefined || oldSpeed === newSpeed) return;
    const currentTime = battle.currentTime ?? 0;
    const remaining = Math.max(0, battle.actionValue[userId] - currentTime);
    battle.actionValue[userId] = currentTime + remaining * (Math.max(1, oldSpeed) / Math.max(1, newSpeed));
  }

  mutateEffectsWithSpeedUpdate(battle, userId, mutation) {
    const oldSpeed = this.getEffectiveStats(battle, userId).speed;
    const result = mutation();
    const newSpeed = this.getEffectiveStats(battle, userId).speed;
    this.rescaleActionValue(battle, userId, oldSpeed, newSpeed);
    return result;
  }

  upsertBuff(battle, userId, buff) {
    return this.mutateEffectsWithSpeedUpdate(battle, userId, () => {
      const buffs = this.getBuffs(battle, userId);
      const existing = buffs.find((entry) => entry.skillId === buff.skillId);
      if (existing) Object.assign(existing, buff);
      else buffs.push(buff);
      return existing ?? buff;
    });
  }

  upsertShield(battle, userId, shield) {
    const shields = this.getShields(battle, userId);
    const existing = shields.find((entry) => entry.skillId === shield.skillId);
    if (existing) Object.assign(existing, shield);
    else shields.push(shield);
    return existing ?? shield;
  }

  applyEnemyDebuff(battle, targetId, skill) {
    const duration = skill.enemyDebuff?.duration ?? skill.duration ?? 1;
    const applied = this.mutateEffectsWithSpeedUpdate(battle, targetId, () => {
      const debuffs = this.getDebuffs(battle, targetId);
      const entry = {
        skillId: skill.id,
        name: skill.name,
        modifiers: { ...skill.enemyDebuff },
        remainingTurns: duration,
      };
      delete entry.modifiers.duration;
      const existing = debuffs.find((debuff) => debuff.skillId === skill.id);
      if (existing) Object.assign(existing, entry);
      else debuffs.push(entry);
      return existing ?? entry;
    });

    const actionDelayPercent = Number(skill.enemyDebuff?.actionDelayPercent ?? 0);
    if (actionDelayPercent > 0) {
      const targetSpeed = this.getEffectiveStats(battle, targetId).speed;
      battle.actionValue[targetId] += (10_000 / Math.max(1, targetSpeed)) * (actionDelayPercent / 100);
    }
    return applied;
  }

  cleanseDebuffs(battle, userId, count) {
    return this.mutateEffectsWithSpeedUpdate(battle, userId, () => {
      const debuffs = this.getDebuffs(battle, userId);
      const removed = debuffs.splice(0, Math.max(0, count));
      return removed;
    });
  }

  advanceEndOfTurnEffects(battle, userId, usedSkillId = null) {
    const expired = [];
    this.mutateEffectsWithSpeedUpdate(battle, userId, () => {
      for (const buff of this.getBuffs(battle, userId)) {
        if (buff.type === 'REGEN') continue;
        if (buff.skipNextDecrement) buff.skipNextDecrement = false;
        else buff.remainingTurns -= 1;
      }
      const expiredBuffs = this.getBuffs(battle, userId).filter(
        (buff) => buff.type !== 'REGEN' && buff.remainingTurns <= 0,
      );
      expired.push(...expiredBuffs.map((buff) => buff.name));
      battle.buffsByUser[userId] = this.getBuffs(battle, userId).filter(
        (buff) => buff.type === 'REGEN' || buff.remainingTurns > 0,
      );

      for (const debuff of this.getDebuffs(battle, userId)) debuff.remainingTurns -= 1;
      const expiredDebuffs = this.getDebuffs(battle, userId).filter((debuff) => debuff.remainingTurns <= 0);
      expired.push(...expiredDebuffs.map((debuff) => debuff.name));
      battle.debuffsByUser[userId] = this.getDebuffs(battle, userId).filter((debuff) => debuff.remainingTurns > 0);
    });

    for (const shield of this.getShields(battle, userId)) {
      if (shield.skipNextDecrement) shield.skipNextDecrement = false;
      else shield.remainingTurns -= 1;
    }
    const expiredShields = this.getShields(battle, userId).filter((shield) => shield.remainingTurns <= 0);
    expired.push(...expiredShields.map((shield) => shield.name));
    battle.shieldsByUser[userId] = this.getShields(battle, userId).filter(
      (shield) => shield.remainingTurns > 0 && shield.amount > 0,
    );

    const cooldowns = battle.cooldownsByUser[userId];
    for (const [skillId, remaining] of Object.entries(cooldowns)) {
      if (skillId !== usedSkillId) cooldowns[skillId] = Math.max(0, remaining - 1);
      if (cooldowns[skillId] === 0) delete cooldowns[skillId];
    }
    return [...new Set(expired)];
  }

  processTurnStart(battle, userId) {
    const messages = [];
    const buffs = this.getBuffs(battle, userId);
    for (const regen of buffs.filter((buff) => buff.type === 'REGEN')) {
      const before = battle.health[userId];
      battle.health[userId] = roundHealth(Math.min(
        battle.stats[userId].health,
        before + regen.amount,
      ));
      const recovered = roundHealth(battle.health[userId] - before);
      regen.remainingTurns -= 1;
      messages.push(`🌿 <@${userId}> **${regen.name}** · 체력 **${recovered} 회복**`);
      if (regen.remainingTurns <= 0) messages.push(`✨ **${regen.name}** 효과가 종료되었습니다.`);
    }
    battle.buffsByUser[userId] = buffs.filter((buff) => buff.type !== 'REGEN' || buff.remainingTurns > 0);
    return messages;
  }

  applyDamage(battle, targetId, damage) {
    const result = consumeIncomingDamage({
      health: battle.health[targetId],
      shields: this.getShields(battle, targetId),
      buffs: this.getBuffs(battle, targetId),
      damage,
    });
    battle.health[targetId] = result.healthAfter;
    battle.shieldsByUser[targetId] = result.shields;
    battle.buffsByUser[targetId] = result.buffs;
    return result;
  }

  resolveAttack(battle, attackerId, defenderId, {
    power,
    damageType = 'PHYSICAL',
    hitCount = 1,
    executeThreshold = null,
    executeDamageMultiplier = 1,
  }) {
    const attackerStats = this.getEffectiveStats(battle, attackerId);
    const defenderStats = this.getEffectiveStats(battle, defenderId);
    const defense = damageType === 'MAGICAL' ? defenderStats.magicDefense : defenderStats.defense;
    const executeActive = executeThreshold !== null
      && battle.health[defenderId] / Math.max(1, battle.stats[defenderId].health) <= executeThreshold;
    const hits = [];
    for (let index = 0; index < Math.max(1, hitCount); index += 1) {
      if (battle.health[defenderId] <= 0) break;
      const rolled = calculateDamageHit({
        power,
        defense,
        attackerLevel: attackerStats.playerLevel,
        criticalChance: attackerStats.criticalChance,
        criticalDamage: attackerStats.criticalDamage,
        damageReductionPercent: defenderStats.damageReductionPercent,
        damageTakenIncreasePercent: defenderStats.damageTakenIncreasePercent,
        executeMultiplier: executeActive ? executeDamageMultiplier : 1,
      });
      const applied = this.applyDamage(battle, defenderId, rolled.damage);
      hits.push({ ...rolled, ...applied });
    }
    return {
      hits,
      executeActive,
      totalDamage: hits.reduce((total, hit) => total + hit.damage, 0),
      totalHealthDamage: roundHealth(hits.reduce((total, hit) => total + hit.healthDamage, 0)),
      totalShieldAbsorbed: roundHealth(hits.reduce((total, hit) => total + hit.absorbedByShield, 0)),
      criticalHits: hits.filter((hit) => hit.critical).length,
      lethalGuardTriggered: hits.some((hit) => hit.lethalGuardTriggered),
    };
  }

  createResourceBar(current, maximum, filled = '🟥') {
    const count = Math.round(Math.min(1, Math.max(0, current / maximum)) * RESOURCE_BAR_SEGMENTS);
    return filled.repeat(count) + '⬛'.repeat(RESOURCE_BAR_SEGMENTS - count);
  }

  getFutureTurns(session, count = 5) {
    const values = { ...session.battle.actionValue };
    const result = [];
    for (let index = 0; index < count; index += 1) {
      const userId = [...session.memberIds].sort((left, right) =>
        values[left] - values[right] || session.memberIds.indexOf(left) - session.memberIds.indexOf(right),
      )[0];
      result.push({ userId, value: values[userId] });
      values[userId] += 10_000 / Math.max(1, this.getEffectiveStats(session.battle, userId).speed);
    }
    return result;
  }

  async renderBattle(guild, session) {
    const channel = guild.channels.cache.get(session.textChannelId);
    const battle = session.battle;
    const playerStatus = session.memberIds.map((userId) => {
      const stats = this.getEffectiveStats(battle, userId);
      const buffs = this.getBuffs(battle, userId);
      const debuffs = this.getDebuffs(battle, userId);
      const shields = this.getShields(battle, userId);
      const cooldowns = Object.entries(battle.cooldownsByUser[userId])
        .filter(([, remaining]) => remaining > 0)
        .map(([skillId, remaining]) => `${getSkill(skillId)?.name ?? skillId} ${remaining}턴`);
      return [
        `<@${userId}> · Lv.${stats.playerLevel}`,
        `❤️ 체력 ${this.createResourceBar(battle.health[userId], stats.health)} ${battle.health[userId]}/${stats.health}`,
        `🔷 마나 ${this.createResourceBar(battle.mana[userId], stats.mana, '🟦')} ${battle.mana[userId]}/${stats.mana}`,
        `🛡️ 보호막 **${getShieldTotal(shields)}**${shields.length ? ` · ${shields.map((shield) => `${shield.name} ${shield.remainingTurns}턴`).join(', ')}` : ''}`,
        `⚔️ 공격력 ${stats.attack}\t✨ 마법 공격력 ${stats.magicAttack}`,
        `🛡️ 방어력 ${stats.defense}\t🔮 마법 방어력 ${stats.magicDefense}\t💨 속도 ${stats.speed}`,
        `🎯 치명타 확률 ${stats.criticalChance}%\t💥 치명타 피해 ${stats.criticalDamage}%`,
        `⬆️ 버프: ${buffs.length ? buffs.map(formatBuff).join(', ') : '없음'}`,
        `⬇️ 디버프: ${debuffs.length ? debuffs.map(formatDebuff).join(', ') : '없음'}`,
        `⏳ 재사용 대기: ${cooldowns.length ? cooldowns.join(', ') : '없음'}`,
      ].join('\n');
    }).join('\n\n');
    const future = this.getFutureTurns(session).map((turn, index) => `${index + 1}. <@${turn.userId}>(${Math.ceil(turn.value)})`).join(' → ');
    const payload = {
      content: [TURN_SEPARATOR, `# 🟢 <@${battle.turnUserId}>님의 턴 · 콜로세움`, '**결투자 상태**', playerStatus, `**다음 5턴** ${future}`, TURN_SEPARATOR].join('\n'),
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pvp:attack:${session.id}:${battle.token}`).setLabel('일반 공격 · 현재 턴 전용').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`pvp:skill:${session.id}:${battle.token}`).setLabel('스킬 · 현재 턴 전용').setStyle(ButtonStyle.Primary),
      )],
    };
    if (battle.message) await battle.message.edit(payload); else battle.message = await channel.send(payload);
  }

  async nextTurn(guild, session) {
    const battle = session.battle;
    const next = [...session.memberIds].sort((a, b) => battle.actionValue[a] - battle.actionValue[b] || session.memberIds.indexOf(a) - session.memberIds.indexOf(b))[0];
    battle.currentTime = Math.max(battle.currentTime ?? 0, battle.actionValue[next]);
    battle.turnUserId = next;
    battle.actionValue[next] += 10_000 / Math.max(1, this.getEffectiveStats(battle, next).speed);
    battle.token = randomUUID().slice(0, 8);
    const turnStartMessages = this.processTurnStart(battle, next);
    if (turnStartMessages.length > 0) {
      await guild.channels.cache.get(session.textChannelId)?.send(turnStartMessages.join('\n'));
    }
    await this.renderBattle(guild, session);
  }

  async start(guild, challenger, opponent, playerStore) {
    if (this.getByUser(challenger.id) || this.getByUser(opponent.id)) {
      return { ok: false, reason: 'ALREADY_IN_PVP' };
    }
    const required = [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers];
    if (!guild.members.me.permissions.has(required)) {
      return { ok: false, reason: 'BOT_MISSING_PERMISSIONS' };
    }

    let category = guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name === PVP_CATEGORY_NAME,
    );
    if (!category) {
      category = await guild.channels.create({
        name: PVP_CATEGORY_NAME,
        type: ChannelType.GuildCategory,
        reason: 'PVP 결투 채널 관리',
      });
    }

    const members = [challenger, opponent];
    const voiceChannel = await guild.channels.create({
      name: '콜로세움',
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: createOverwrites(guild, members, true),
      reason: `${challenger.user.tag}님과 ${opponent.user.tag}님의 결투`,
    });
    let textChannel;
    try {
      textChannel = await guild.channels.create({
        name: '채팅-콜로세움',
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `${challenger.user.tag} VS ${opponent.user.tag}`,
        permissionOverwrites: createOverwrites(guild, members, false),
        reason: 'PVP 결투 채팅방 생성',
      });
      await Promise.all(
        members.map((member) => member.voice.setChannel(voiceChannel, 'PVP 결투 수락')),
      );
    } catch (error) {
      await Promise.all([
        voiceChannel.delete('PVP 생성 실패').catch(() => {}),
        textChannel?.delete('PVP 생성 실패').catch(() => {}),
      ]);
      throw error;
    }

    const session = {
      id: randomUUID(),
      guildId: guild.id,
      memberIds: members.map((member) => member.id),
      challengerId: challenger.id,
      opponentId: opponent.id,
      categoryId: category.id,
      voiceChannelId: voiceChannel.id,
      textChannelId: textChannel.id,
    };
    this.sessions.set(session.id, session);
    for (const member of members) this.userSessions.set(member.id, session.id);
    await textChannel.send(
      `# ⚔️ 콜로세움 결투\n<@${challenger.id}> **VS** <@${opponent.id}>\n\n두 결투자만 이 채널과 음성 채널을 이용할 수 있습니다.`,
    );
    const players = Object.fromEntries(await Promise.all(members.map(async (member) => [member.id, await playerStore.getOrCreate(member.id)])));
    const stats = Object.fromEntries(session.memberIds.map((id) => [id, calculateTotalStats(players[id])]));
    for (const userId of session.memberIds) {
      stats[userId].health = roundHealth(stats[userId].health);
      stats[userId].mana = roundMana(stats[userId].mana);
    }
    session.battle = {
      stats,
      health: Object.fromEntries(session.memberIds.map((id) => [id, roundHealth(stats[id].health)])),
      mana: Object.fromEntries(session.memberIds.map((id) => [id, stats[id].mana])),
      equippedSkills: Object.fromEntries(session.memberIds.map((id) => [id, [...players[id].equippedSkills]])),
      buffsByUser: Object.fromEntries(session.memberIds.map((id) => [id, []])),
      debuffsByUser: Object.fromEntries(session.memberIds.map((id) => [id, []])),
      shieldsByUser: Object.fromEntries(session.memberIds.map((id) => [id, []])),
      cooldownsByUser: Object.fromEntries(session.memberIds.map((id) => [id, {}])),
      oncePerBattleByUser: Object.fromEntries(session.memberIds.map((id) => [id, []])),
      actionValue: Object.fromEntries(
        session.memberIds.map((id) => [id, 10_000 / Math.max(1, stats[id].speed)]),
      ),
      currentTime: 0,
      turnUserId: null,
      token: null,
      message: null,
      actionCount: 0,
    };
    await this.nextTurn(guild, session);
    return { ok: true, session };
  }

  getSkillButtonStyle(skill) {
    if (skill.type === 'ATTACK') return ButtonStyle.Danger;
    if (['HEAL', 'REGEN'].includes(skill.type)) return ButtonStyle.Success;
    if (['ENEMY_DEBUFF', 'TAUNT'].includes(skill.type)) return ButtonStyle.Secondary;
    return ButtonStyle.Primary;
  }

  spendAndMarkSkill(battle, userId, skill) {
    battle.mana[userId] = roundMana(battle.mana[userId] - getSkillManaCost(skill));
    this.markSkillUsed(battle, userId, skill);
    battle.token = null;
  }

  async completePvpAction(interaction, session, actorId, usedSkillId = null) {
    await waitAfterAction();
    if (this.sessions.get(session.id) !== session) return;
    const defeatedId = session.memberIds.find((userId) => session.battle.health[userId] <= 0);
    if (defeatedId) {
      const winnerId = session.memberIds.find((userId) => userId !== defeatedId);
      await interaction.guild.channels.cache.get(session.textChannelId)?.send(
        `# 🏆 결투 종료\n<@${winnerId}>님의 승리!`,
      );
      setTimeout(() => this.end(interaction.client, session.id, '결투 종료').catch(() => {}), 10_000);
      return;
    }

    const expired = this.advanceEndOfTurnEffects(session.battle, actorId, usedSkillId);
    session.battle.actionCount += 1;
    if (expired.length > 0) {
      await interaction.guild.channels.cache.get(session.textChannelId)?.send(
        `✨ <@${actorId}>님의 ${expired.map((name) => `**${name}**`).join(', ')} 효과가 종료되었습니다.`,
      );
    }
    await this.nextTurn(interaction.guild, session);
  }

  createAttackResultLines(session, defenderId, result, damageLabel) {
    const hitText = result.hits.length > 1
      ? result.hits.map((hit, index) => `${index + 1}타 ${hit.damage}${hit.critical ? ' 치명타' : ''}`).join(' · ')
      : null;
    return [
      `# 💥 ${result.totalDamage} ${damageLabel}${result.criticalHits > 0 ? ` · 치명타 ${result.criticalHits}회!` : ''}`,
      hitText,
      result.executeActive ? '☠️ **처형 조건 발동!**' : null,
      result.totalShieldAbsorbed > 0 ? `🛡️ 보호막이 **${result.totalShieldAbsorbed} 피해**를 흡수했습니다.` : null,
      result.lethalGuardTriggered ? '🔥 **불굴 발동! 치명적인 피해를 버티고 체력 1로 생존했습니다.**' : null,
      `<@${defenderId}>의 남은 체력: **${session.battle.health[defenderId]}/${session.battle.stats[defenderId].health}**`,
    ].filter(Boolean);
  }

  async executeAttackSkill(interaction, session, actorId, skill) {
    const battle = session.battle;
    const defenderId = session.memberIds.find((id) => id !== actorId);
    const actorStats = this.getEffectiveStats(battle, actorId);
    const power = calculateSkillPower(skill, actorStats);
    const result = this.resolveAttack(battle, actorId, defenderId, {
      power,
      damageType: skill.damageType,
      hitCount: skill.hitCount,
      executeThreshold: skill.executeThreshold,
      executeDamageMultiplier: skill.executeDamageMultiplier,
    });

    let lifeSteal = 0;
    if (skill.lifeStealRatio && result.totalHealthDamage > 0) {
      const before = battle.health[actorId];
      battle.health[actorId] = roundHealth(Math.min(
        battle.stats[actorId].health,
        before + result.totalHealthDamage * skill.lifeStealRatio,
      ));
      lifeSteal = roundHealth(battle.health[actorId] - before);
    }
    const appliedDebuff = skill.enemyDebuff && battle.health[defenderId] > 0
      ? this.applyEnemyDebuff(battle, defenderId, skill)
      : null;

    this.spendAndMarkSkill(battle, actorId, skill);
    let restoredMana = 0;
    if (skill.manaRestoreFlat) {
      const manaBeforeRestore = battle.mana[actorId];
      battle.mana[actorId] = roundMana(Math.min(
        battle.stats[actorId].mana,
        manaBeforeRestore + skill.manaRestoreFlat,
      ));
      restoredMana = roundMana(battle.mana[actorId] - manaBeforeRestore);
    }
    await interaction.update({ content: `${skill.name} 시전을 완료했습니다.`, components: [] });
    const damageLabel = skill.damageType === 'PHYSICAL' ? '물리 피해' : '마법 피해';
    await battle.message.edit({
      content: [
        TURN_SEPARATOR,
        `## 🟢 <@${actorId}>님의 턴`,
        `### ${skill.damageType === 'PHYSICAL' ? '🗡️' : '✨'} 「${skill.name}」 시전`,
        ...this.createAttackResultLines(session, defenderId, result, damageLabel),
        lifeSteal > 0 ? `🩸 실제 체력 피해의 **${Math.round(skill.lifeStealRatio * 100)}%**, 체력 **${lifeSteal} 회복**` : null,
        restoredMana > 0 ? `🔷 마나 **${restoredMana} 회복**` : null,
        appliedDebuff ? `⬇️ <@${defenderId}>에게 **${formatDebuff(appliedDebuff)}** 부여` : null,
        skill.enemyDebuff?.actionDelayPercent
          ? `⏳ 상대의 행동 게이지를 **${skill.enemyDebuff.actionDelayPercent}% 지연**했습니다.`
          : null,
        getSkillManaCost(skill) > 0 ? `남은 마나: **${battle.mana[actorId]}**` : '⚔️ 마나를 소모하지 않았습니다.',
        TURN_SEPARATOR,
      ].filter(Boolean).join('\n'),
      components: [],
    });
    await this.completePvpAction(interaction, session, actorId, skill.id);
  }

  async executeHealSkill(interaction, session, actorId, skill) {
    const battle = session.battle;
    const stats = this.getEffectiveStats(battle, actorId);
    const before = battle.health[actorId];
    const canCleanse = (skill.cleanseCount ?? 0) > 0 && this.getDebuffs(battle, actorId).length > 0;
    const grantsShield = (skill.shieldCoefficient ?? 0) > 0
      || (skill.shieldMaxHealthCoefficient ?? 0) > 0;
    if (before >= battle.stats[actorId].health && !canCleanse && !grantsShield) {
      return interaction.reply({ content: '체력이 이미 최대이며 함께 적용할 다른 효과도 없습니다.', flags: MessageFlags.Ephemeral });
    }

    const healing = calculateHealingAmount(skill, stats, before);
    battle.health[actorId] = roundHealth(Math.min(battle.stats[actorId].health, before + healing));
    const recovered = roundHealth(battle.health[actorId] - before);
    const cleansed = skill.cleanseCount ? this.cleanseDebuffs(battle, actorId, skill.cleanseCount) : [];
    let shieldAmount = 0;
    if (grantsShield) {
      shieldAmount = calculateShieldAmount(skill, stats);
      this.upsertShield(battle, actorId, {
        skillId: skill.id,
        name: skill.name,
        amount: shieldAmount,
        remainingTurns: skill.duration ?? 3,
        skipNextDecrement: true,
      });
    }

    this.spendAndMarkSkill(battle, actorId, skill);
    await interaction.update({ content: `${skill.name} 시전을 완료했습니다.`, components: [] });
    await battle.message.edit({
      content: [
        TURN_SEPARATOR,
        `## 🟢 <@${actorId}>님의 턴`,
        `### ✨ 「${skill.name}」 시전`,
        `# 💚 체력 ${recovered} 회복`,
        cleansed.length ? `✨ 디버프 정화: ${cleansed.map((debuff) => `**${debuff.name}**`).join(', ')}` : null,
        shieldAmount > 0 ? `🛡️ 보호막 **${shieldAmount}** 획득 · ${skill.duration ?? 3}턴` : null,
        `현재 체력: **${battle.health[actorId]}/${battle.stats[actorId].health}**`,
        getSkillManaCost(skill) > 0 ? `남은 마나: **${battle.mana[actorId]}**` : null,
        TURN_SEPARATOR,
      ].filter(Boolean).join('\n'),
      components: [],
    });
    await this.completePvpAction(interaction, session, actorId, skill.id);
  }

  async executeSupportSkill(interaction, session, actorId, skill) {
    const battle = session.battle;
    const stats = this.getEffectiveStats(battle, actorId);
    const duration = skill.duration ?? 1;
    const common = {
      skillId: skill.id,
      name: skill.name,
      remainingTurns: duration,
      skipNextDecrement: true,
    };
    let effectLine;

    if (skill.type === 'REGEN') {
      const amount = calculateRegenAmount(skill, stats);
      this.upsertBuff(battle, actorId, { ...common, type: 'REGEN', amount, skipNextDecrement: false });
      effectLine = `🌿 자신의 턴 시작마다 체력 **${amount} 회복** · ${duration}회`;
    } else if (skill.type === 'SHIELD') {
      const amount = calculateShieldAmount(skill, stats);
      this.upsertShield(battle, actorId, { ...common, amount });
      effectLine = `🛡️ 보호막 **${amount}** 획득 · ${duration}턴`;
    } else if (skill.type === 'ATTACK_BUFF') {
      const amount = skill.buffMode === 'FLAT' ? calculateSkillPower(skill, stats) : 0;
      this.upsertBuff(battle, actorId, {
        ...common,
        type: skill.type,
        buffMode: skill.buffMode,
        affectedStats: [...(skill.affectedStats ?? ['attack', 'magicAttack'])],
        amount,
        buffPercent: skill.buffPercent ?? 0,
      });
      effectLine = skill.buffMode === 'PERCENT'
        ? `⚔️ 공격력·마법 공격력 **${skill.buffPercent}% 증가** · ${duration}턴`
        : `⚔️ 공격력·마법 공격력 **${amount} 증가** · ${duration}턴`;
    } else if (skill.type === 'DEFENSE_BUFF') {
      const amount = calculateSkillPower(skill, stats);
      this.upsertBuff(battle, actorId, { ...common, type: skill.type, amount });
      effectLine = `🛡️ 방어력·마법 방어력 **${amount} 증가** · ${duration}턴`;
    } else if (skill.type === 'DAMAGE_REDUCTION_BUFF') {
      this.upsertBuff(battle, actorId, {
        ...common,
        type: skill.type,
        damageReductionPercent: skill.damageReductionPercent,
      });
      effectLine = `🛡️ 받는 피해 **${skill.damageReductionPercent}% 감소** · ${duration}턴`;
    } else if (skill.type === 'SPEED_BUFF') {
      this.upsertBuff(battle, actorId, {
        ...common,
        type: skill.type,
        speedIncreasePercent: skill.speedIncreasePercent,
      });
      effectLine = `💨 속도 **${skill.speedIncreasePercent}% 증가** · ${duration}턴`;
    } else if (skill.type === 'CRITICAL_BUFF') {
      this.upsertBuff(battle, actorId, {
        ...common,
        type: skill.type,
        criticalChanceIncrease: skill.criticalChanceIncrease,
      });
      effectLine = `🎯 치명타 확률 **${skill.criticalChanceIncrease}% 증가** · ${duration}턴`;
    } else if (skill.type === 'VERSATILE_BUFF') {
      this.upsertBuff(battle, actorId, {
        ...common,
        type: skill.type,
        statPercentModifiers: { ...skill.statPercentModifiers },
      });
      effectLine = `🌟 ${Object.entries(skill.statPercentModifiers ?? {})
        .map(([stat, value]) => `${({ attack: '공격력', magicAttack: '마법 공격력', defense: '방어력', speed: '속도' })[stat] ?? stat} **${value}% 증가**`)
        .join(' · ')} · ${duration}턴`;
    } else if (skill.type === 'MANA_RESTORE') {
      const before = battle.mana[actorId];
      battle.mana[actorId] = roundMana(Math.min(
        battle.stats[actorId].mana,
        before + battle.stats[actorId].mana * skill.restoreManaRatio,
      ));
      const restored = roundMana(battle.mana[actorId] - before);
      if (restored <= 0) {
        return interaction.reply({ content: '마나가 이미 최대입니다.', flags: MessageFlags.Ephemeral });
      }
      effectLine = `🔷 마나 **${restored} 회복** (${before} → ${battle.mana[actorId]}/${battle.stats[actorId].mana})`;
    } else if (skill.type === 'TAUNT') {
      if (!skill.damageReductionPercent && !skill.lethalGuardCharges) {
        return interaction.reply({
          content: '도발은 공격 대상을 자신으로 고정하는 파티 전용 효과라서 1대1 결투에서는 사용할 수 없습니다.',
          flags: MessageFlags.Ephemeral,
        });
      }
      this.upsertBuff(battle, actorId, {
        ...common,
        type: 'UNYIELDING',
        damageReductionPercent: skill.damageReductionPercent,
        lethalGuardCharges: skill.lethalGuardCharges,
      });
      effectLine = `🔥 받는 피해 **${skill.damageReductionPercent}% 감소** · 치명 피해 **${skill.lethalGuardCharges}회** 체력 1로 생존 · ${duration}턴`;
    } else {
      return interaction.reply({ content: '결투에서 지원하지 않는 스킬 유형입니다.', flags: MessageFlags.Ephemeral });
    }

    this.spendAndMarkSkill(battle, actorId, skill);
    await interaction.update({ content: `${skill.name} 시전을 완료했습니다.`, components: [] });
    await battle.message.edit({
      content: [
        TURN_SEPARATOR,
        `## 🟢 <@${actorId}>님의 턴`,
        `### ✨ 「${skill.name}」 시전`,
        effectLine,
        getSkillManaCost(skill) > 0 ? `남은 마나: **${battle.mana[actorId]}**` : '⚔️ 마나를 소모하지 않았습니다.',
        TURN_SEPARATOR,
      ].join('\n'),
      components: [],
    });
    await this.completePvpAction(interaction, session, actorId, skill.id);
  }

  async executeEnemyDebuffSkill(interaction, session, actorId, skill) {
    const battle = session.battle;
    const defenderId = session.memberIds.find((id) => id !== actorId);
    const applied = this.applyEnemyDebuff(battle, defenderId, skill);
    this.spendAndMarkSkill(battle, actorId, skill);
    await interaction.update({ content: `${skill.name} 시전을 완료했습니다.`, components: [] });
    await battle.message.edit({
      content: [
        TURN_SEPARATOR,
        `## 🟢 <@${actorId}>님의 턴`,
        `### 🕸️ 「${skill.name}」 시전`,
        `⬇️ <@${defenderId}>에게 **${formatDebuff(applied)}** 부여`,
        skill.enemyDebuff?.actionDelayPercent
          ? `⏳ 상대의 행동 게이지를 **${skill.enemyDebuff.actionDelayPercent}% 지연**했습니다.`
          : null,
        getSkillManaCost(skill) > 0 ? `남은 마나: **${battle.mana[actorId]}**` : null,
        TURN_SEPARATOR,
      ].filter(Boolean).join('\n'),
      components: [],
    });
    await this.completePvpAction(interaction, session, actorId, skill.id);
  }

  async executeNormalAttack(interaction, session, actorId) {
    const battle = session.battle;
    const defenderId = session.memberIds.find((id) => id !== actorId);
    const attacker = this.getEffectiveStats(battle, actorId);
    const result = this.resolveAttack(battle, actorId, defenderId, {
      power: attacker.attack,
      damageType: 'PHYSICAL',
    });
    battle.token = null;
    await interaction.deferUpdate();
    await battle.message.edit({
      content: [
        TURN_SEPARATOR,
        `## 🟢 <@${actorId}>님의 턴`,
        '### 🗡️ 「일반 공격」 시전',
        ...this.createAttackResultLines(session, defenderId, result, '물리 피해'),
        TURN_SEPARATOR,
      ].join('\n'),
      components: [],
    });
    await this.completePvpAction(interaction, session, actorId);
  }

  async handleButton(interaction) {
    const [, action, sessionId, token, skillId] = interaction.customId.split(':');
    const session = this.sessions.get(sessionId);
    if (!session?.battle || token !== session.battle.token) {
      return interaction.reply({ content: '이미 처리된 결투 행동입니다.', flags: MessageFlags.Ephemeral });
    }
    if (interaction.user.id !== session.battle.turnUserId) {
      return interaction.reply({ content: '현재 턴인 플레이어만 행동할 수 있습니다.', flags: MessageFlags.Ephemeral });
    }
    const actorId = interaction.user.id;
    const battle = session.battle;

    if (action === 'skill') {
      const skills = battle.equippedSkills[actorId].map(getSkill).filter(Boolean);
      if (skills.length === 0) {
        return interaction.reply({ content: '장착한 스킬이 없습니다.', flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({
        content: '이번 턴에 시전할 스킬을 선택하세요.',
        components: [new ActionRowBuilder().addComponents(skills.map((skill) => {
          const cooldown = this.getCooldown(battle, actorId, skill.id);
          const usedOnce = skill.oncePerBattle && this.hasUsedOnceSkill(battle, actorId, skill.id);
          const state = usedOnce ? ' · 사용 완료' : cooldown > 0 ? ` · ${cooldown}턴` : '';
          return new ButtonBuilder()
            .setCustomId(`pvp:skill_select:${session.id}:${token}:${skill.id}`)
            .setLabel(`${skill.name} · ${getSkillCostText(skill)}${state}`.slice(0, 80))
            .setStyle(this.getSkillButtonStyle(skill))
            .setDisabled(Boolean(usedOnce || cooldown > 0));
        }))],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (action === 'skill_select') {
      const skill = getSkill(skillId);
      if (!skill || !battle.equippedSkills[actorId].includes(skillId)) {
        return interaction.reply({ content: '장착하지 않은 스킬입니다.', flags: MessageFlags.Ephemeral });
      }
      const unavailableReason = this.getSkillUnavailableReason(battle, actorId, skill);
      if (unavailableReason) return interaction.reply({ content: unavailableReason, flags: MessageFlags.Ephemeral });
      if (battle.mana[actorId] < getSkillManaCost(skill)) {
        return interaction.reply({ content: '스킬 시전에 필요한 마나가 부족합니다.', flags: MessageFlags.Ephemeral });
      }

      if (skill.type === 'ATTACK') return this.executeAttackSkill(interaction, session, actorId, skill);
      if (skill.type === 'HEAL') return this.executeHealSkill(interaction, session, actorId, skill);
      if (skill.type === 'ENEMY_DEBUFF') return this.executeEnemyDebuffSkill(interaction, session, actorId, skill);
      return this.executeSupportSkill(interaction, session, actorId, skill);
    }

    if (action !== 'attack') {
      return interaction.reply({ content: '결투에서는 아이템을 사용할 수 없습니다.', flags: MessageFlags.Ephemeral });
    }
    return this.executeNormalAttack(interaction, session, actorId);
  }

  async movePlayersToPlaza(guild, session) {
    const plazaCategory = guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name === PLAZA_CATEGORY_NAME,
    );
    const plazaChannel = plazaCategory && guild.channels.cache.find(
      (channel) =>
        channel.type === ChannelType.GuildVoice
        && channel.name === PLAZA_CHANNEL_NAME
        && channel.parentId === plazaCategory.id,
    );
    if (!plazaChannel) return false;
    const members = await Promise.all(session.memberIds.map((userId) => guild.members.fetch(userId).catch(() => null)));
    await Promise.all(
      members
        .filter((member) => member?.voice.channelId === session.voiceChannelId)
        .map((member) => member.voice.setChannel(plazaChannel, 'PVP 결투 종료 후 광장으로 복귀').catch(() => {})),
    );
    return true;
  }

  async end(client, sessionId, reason = 'PVP_ENDED') {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    for (const userId of session.memberIds) this.userSessions.delete(userId);
    const guild = client.guilds.cache.get(session.guildId);
    if (!guild) return true;
    await this.movePlayersToPlaza(guild, session);
    await Promise.all([
      guild.channels.cache.get(session.voiceChannelId)?.delete(reason).catch(() => {}),
      guild.channels.cache.get(session.textChannelId)?.delete(reason).catch(() => {}),
    ]);
    await guild.channels.fetch().catch(() => {});
    const category = guild.channels.cache.get(session.categoryId);
    const remaining = guild.channels.cache.filter((channel) => channel.parentId === session.categoryId);
    if (category && remaining.size === 0) await category.delete('진행 중인 PVP 없음').catch(() => {});
    return true;
  }

  async handleVoiceStateUpdate(client, oldState, newState) {
    const session = this.getByUser(oldState.id);
    if (session && oldState.channelId === session.voiceChannelId && newState.channelId !== session.voiceChannelId) {
      await this.end(client, session.id, '결투자가 콜로세움을 떠남');
    }
  }
}

export const pvpManager = new PvpManager();
