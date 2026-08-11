export const MAX_EQUIPPED_SKILLS = 3;
export const STARTER_SKILL_IDS = ['magic_bolt', 'basic_heal'];
export const skillRarities = ['일반', '고급', '레어', '전설'];

const skillFragmentDropConfig = {
  MONSTER: {
    chance: 0.12,
    weights: { 일반: 55, 고급: 30, 레어: 12, 전설: 3 },
  },
  BOSS: {
    chance: 1,
    weights: { 일반: 35, 고급: 35, 레어: 22, 전설: 8 },
  },
  TREASURE: {
    chance: 0.3,
    weights: { 일반: 50, 고급: 30, 레어: 15, 전설: 5 },
  },
};

export const skillCatalog = {
  magic_bolt: {
    id: 'magic_bolt', name: '마력탄', rarity: '일반', roleTags: ['마법 딜러'],
    manaCost: 8, magicAttackCoefficient: 1.1, type: 'ATTACK', targetType: 'ENEMY',
    scalingStat: 'magicAttack', damageType: 'MAGICAL',
  },
  basic_heal: {
    id: 'basic_heal', name: '치유의 빛', rarity: '일반', roleTags: ['힐러'],
    manaCost: 8, magicAttackCoefficient: 0.7, type: 'HEAL', targetType: 'ALLY',
    scalingStat: 'magicAttack',
  },
  guardian_taunt: {
    id: 'guardian_taunt', name: '수호자의 도발', rarity: '일반', roleTags: ['탱커'],
    manaCost: 0, cooldownTurns: 3, duration: 3, type: 'TAUNT', targetType: 'ENEMY',
  },
  power_strike: {
    id: 'power_strike', name: '강타', rarity: '일반', roleTags: ['물리 딜러'],
    manaCost: 0, cooldownTurns: 2, attackCoefficient: 1.3, type: 'ATTACK', targetType: 'ENEMY',
    scalingStat: 'attack', damageType: 'PHYSICAL',
  },
  iron_wall_stance: {
    id: 'iron_wall_stance', name: '철벽 자세', rarity: '일반', roleTags: ['탱커'],
    manaCost: 0, cooldownTurns: 4, duration: 2, damageReductionPercent: 25,
    type: 'DAMAGE_REDUCTION_BUFF', targetType: 'SELF',
  },
  regeneration_seed: {
    id: 'regeneration_seed', name: '재생의 씨앗', rarity: '일반', roleTags: ['힐러'],
    manaCost: 10, magicAttackCoefficient: 0.25, duration: 3,
    type: 'REGEN', targetType: 'ALLY', scalingStat: 'magicAttack',
  },
  weakening_mark: {
    id: 'weakening_mark', name: '약화의 표식', rarity: '일반', roleTags: ['디버퍼'],
    manaCost: 10, duration: 2, cooldownTurns: 2, type: 'ENEMY_DEBUFF', targetType: 'ENEMY',
    enemyDebuff: { attackReductionPercent: 10 },
  },
  wind_blessing: {
    id: 'wind_blessing', name: '바람의 축복', rarity: '일반', roleTags: ['버퍼'],
    manaCost: 10, duration: 2, cooldownTurns: 3, speedIncreasePercent: 12,
    type: 'SPEED_BUFF', targetType: 'ALLY',
  },

  flame_spear: {
    id: 'flame_spear', name: '화염의 창', rarity: '고급', roleTags: ['마법 딜러'],
    manaCost: 14, magicAttackCoefficient: 1.65, type: 'ATTACK', targetType: 'ENEMY',
    scalingStat: 'magicAttack', damageType: 'MAGICAL',
  },
  advanced_heal: {
    id: 'advanced_heal', name: '상급 치유의 빛', rarity: '고급', roleTags: ['힐러'],
    manaCost: 14, magicAttackCoefficient: 1.25, type: 'HEAL', targetType: 'ALLY',
    scalingStat: 'magicAttack',
  },
  arcane_amplification: {
    id: 'arcane_amplification', name: '마력 증폭', rarity: '고급', roleTags: ['버퍼'],
    manaCost: 16, magicAttackCoefficient: 0.35, duration: 3, cooldownTurns: 3,
    type: 'ATTACK_BUFF', targetType: 'ALLY', scalingStat: 'magicAttack',
    affectedStats: ['attack', 'magicAttack'], buffMode: 'FLAT',
  },
  guardian_barrier: {
    id: 'guardian_barrier', name: '수호 결계', rarity: '고급', roleTags: ['버퍼', '탱커'],
    manaCost: 16, magicAttackCoefficient: 0.45, duration: 3, cooldownTurns: 3,
    type: 'DEFENSE_BUFF', targetType: 'ALLY', scalingStat: 'magicAttack',
    affectedStats: ['defense'], buffMode: 'FLAT',
  },
  armor_breaker: {
    id: 'armor_breaker', name: '방어구 가르기', rarity: '고급', roleTags: ['물리 딜러', '디버퍼'],
    manaCost: 0, cooldownTurns: 3, attackCoefficient: 1.15, type: 'ATTACK', targetType: 'ENEMY',
    scalingStat: 'attack', damageType: 'PHYSICAL',
    enemyDebuff: { defenseReductionPercent: 15, magicDefenseReductionPercent: 15, duration: 2 },
  },
  double_slash: {
    id: 'double_slash', name: '연속 베기', rarity: '고급', roleTags: ['물리 딜러'],
    manaCost: 0, cooldownTurns: 3, attackCoefficient: 0.8, hitCount: 2,
    type: 'ATTACK', targetType: 'ENEMY', scalingStat: 'attack', damageType: 'PHYSICAL',
  },
  cleansing_light: {
    id: 'cleansing_light', name: '정화의 빛', rarity: '고급', roleTags: ['힐러'],
    manaCost: 14, cooldownTurns: 2, magicAttackCoefficient: 0.45, cleanseCount: 1,
    type: 'HEAL', targetType: 'ALLY', scalingStat: 'magicAttack',
  },
  mana_barrier: {
    id: 'mana_barrier', name: '마력 장막', rarity: '고급', roleTags: ['버퍼', '탱커'],
    manaCost: 16, cooldownTurns: 3, duration: 3, magicAttackCoefficient: 0.9,
    type: 'SHIELD', targetType: 'ALLY', scalingStat: 'magicAttack',
  },

  chain_lightning: {
    id: 'chain_lightning', name: '뇌광 폭발', rarity: '레어', roleTags: ['마법 딜러'],
    manaCost: 22, magicAttackCoefficient: 2.4, type: 'ATTACK', targetType: 'ENEMY',
    scalingStat: 'magicAttack', damageType: 'MAGICAL',
  },
  rare_heal: {
    id: 'rare_heal', name: '생명의 파동', rarity: '레어', roleTags: ['힐러'],
    manaCost: 22, magicAttackCoefficient: 2, type: 'HEAL', targetType: 'ALLY',
    scalingStat: 'magicAttack',
  },
  sword_aura_dance: {
    id: 'sword_aura_dance', name: '검기 난무', rarity: '레어', roleTags: ['물리 딜러'],
    manaCost: 0, cooldownTurns: 4, attackCoefficient: 0.75, hitCount: 3,
    type: 'ATTACK', targetType: 'ENEMY', scalingStat: 'attack', damageType: 'PHYSICAL',
  },
  vampiric_slash: {
    id: 'vampiric_slash', name: '흡혈 참격', rarity: '레어', roleTags: ['물리 딜러', '탱커'],
    manaCost: 0, cooldownTurns: 4, attackCoefficient: 1.7, lifeStealRatio: 0.35,
    type: 'ATTACK', targetType: 'ENEMY', scalingStat: 'attack', damageType: 'PHYSICAL',
  },
  chorus_of_life: {
    id: 'chorus_of_life', name: '생명의 합창', rarity: '레어', roleTags: ['힐러'],
    manaCost: 28, cooldownTurns: 3, magicAttackCoefficient: 0.9,
    type: 'HEAL', targetType: 'PARTY', scalingStat: 'magicAttack',
  },
  purification_wave: {
    id: 'purification_wave', name: '정화의 파동', rarity: '레어', roleTags: ['힐러'],
    manaCost: 28, cooldownTurns: 4, magicAttackCoefficient: 0.35, cleanseCount: 1,
    type: 'HEAL', targetType: 'PARTY', scalingStat: 'magicAttack',
  },
  sacred_barrier: {
    id: 'sacred_barrier', name: '신성 방벽', rarity: '레어', roleTags: ['버퍼', '탱커'],
    manaCost: 30, cooldownTurns: 4, duration: 2, magicAttackCoefficient: 0.6,
    type: 'SHIELD', targetType: 'PARTY', scalingStat: 'magicAttack',
  },
  enfeebling_curse: {
    id: 'enfeebling_curse', name: '쇠약의 저주', rarity: '레어', roleTags: ['디버퍼'],
    manaCost: 24, cooldownTurns: 4, duration: 3, type: 'ENEMY_DEBUFF', targetType: 'ENEMY',
    enemyDebuff: { attackReductionPercent: 20, speedReductionPercent: 15 },
  },

  starfall: {
    id: 'starfall', name: '별무리 낙하', rarity: '전설', roleTags: ['마법 딜러'],
    manaCost: 36, magicAttackCoefficient: 3.8, cooldownTurns: 3,
    type: 'ATTACK', targetType: 'ENEMY', scalingStat: 'magicAttack', damageType: 'MAGICAL',
  },
  legendary_heal: {
    id: 'legendary_heal', name: '성역의 기도', rarity: '전설', roleTags: ['힐러'],
    manaCost: 34, magicAttackCoefficient: 3.2, cooldownTurns: 3,
    type: 'HEAL', targetType: 'ALLY', scalingStat: 'magicAttack',
  },
  dragon_slayer_art: {
    id: 'dragon_slayer_art', name: '용살검 오의', rarity: '전설', roleTags: ['물리 딜러'],
    manaCost: 0, cooldownTurns: 5, attackCoefficient: 3.5,
    executeThreshold: 0.25, executeDamageMultiplier: 1.35,
    type: 'ATTACK', targetType: 'ENEMY', scalingStat: 'attack', damageType: 'PHYSICAL',
  },
  unyielding_oath: {
    id: 'unyielding_oath', name: '불굴의 맹세', rarity: '전설', roleTags: ['탱커'],
    manaCost: 0, oncePerBattle: true, duration: 3, damageReductionPercent: 35,
    lethalGuardCharges: 1, type: 'TAUNT', targetType: 'ENEMY',
  },
  god_of_war: {
    id: 'god_of_war', name: '전장의 군신', rarity: '전설', roleTags: ['버퍼', '물리 딜러'],
    manaCost: 0, cooldownTurns: 6, duration: 3, buffPercent: 20,
    affectedStats: ['attack', 'magicAttack'], buffMode: 'PERCENT',
    type: 'ATTACK_BUFF', targetType: 'PARTY',
  },
  heavenly_sanctuary: {
    id: 'heavenly_sanctuary', name: '천상의 성역', rarity: '전설', roleTags: ['힐러', '버퍼'],
    manaCost: 46, cooldownTurns: 5, duration: 3, magicAttackCoefficient: 1.5,
    shieldCoefficient: 0.6, type: 'HEAL', targetType: 'PARTY', scalingStat: 'magicAttack',
  },
  doom_brand: {
    id: 'doom_brand', name: '종말의 낙인', rarity: '전설', roleTags: ['디버퍼'],
    manaCost: 40, cooldownTurns: 5, duration: 3, type: 'ENEMY_DEBUFF', targetType: 'ENEMY',
    enemyDebuff: {
      damageTakenIncreasePercent: 25,
      defenseReductionPercent: 20,
      magicDefenseReductionPercent: 20,
    },
  },
  time_distortion: {
    id: 'time_distortion', name: '시간 왜곡', rarity: '전설', roleTags: ['디버퍼', '버퍼'],
    manaCost: 38, cooldownTurns: 5, duration: 2, type: 'ENEMY_DEBUFF', targetType: 'ENEMY',
    enemyDebuff: { speedReductionPercent: 20, actionDelayPercent: 40 },
  },
  first_aid: {
    id: 'first_aid', name: '응급 처치', rarity: '일반', roleTags: ['솔로', '탱커'],
    manaCost: 0, cooldownTurns: 4, maxHealthCoefficient: 0.12,
    type: 'HEAL', targetType: 'SELF',
  },
  combat_focus: {
    id: 'combat_focus', name: '전투 집중', rarity: '일반', roleTags: ['솔로', '물리 딜러'],
    manaCost: 0, cooldownTurns: 4, duration: 2, criticalChanceIncrease: 12,
    type: 'CRITICAL_BUFF', targetType: 'SELF',
  },
  mana_recovery: {
    id: 'mana_recovery', name: '마력 회수', rarity: '고급', roleTags: ['솔로', '마법 딜러'],
    manaCost: 0, cooldownTurns: 5, restoreManaRatio: 0.25,
    type: 'MANA_RESTORE', targetType: 'SELF',
  },
  swordsman_breath: {
    id: 'swordsman_breath', name: '검사의 호흡', rarity: '고급', roleTags: ['솔로', '물리 딜러'],
    manaCost: 0, cooldownTurns: 4, duration: 2, buffPercent: 20,
    affectedStats: ['attack'], buffMode: 'PERCENT', type: 'ATTACK_BUFF', targetType: 'SELF',
  },
  survivor_step: {
    id: 'survivor_step', name: '생존자의 발걸음', rarity: '고급', roleTags: ['솔로'],
    manaCost: 0, cooldownTurns: 4, duration: 2, speedIncreasePercent: 18,
    type: 'SPEED_BUFF', targetType: 'SELF',
  },
  indomitable_regen: {
    id: 'indomitable_regen', name: '불굴의 재생', rarity: '레어', roleTags: ['솔로', '탱커'],
    manaCost: 0, cooldownTurns: 5, duration: 3, maxHealthCoefficient: 0.08,
    type: 'REGEN', targetType: 'SELF',
  },
  magic_blade_sync: {
    id: 'magic_blade_sync', name: '마검 동조', rarity: '레어', roleTags: ['솔로', '하이브리드 딜러'],
    manaCost: 18, cooldownTurns: 5, duration: 3, buffPercent: 25,
    affectedStats: ['attack', 'magicAttack'], buffMode: 'PERCENT',
    type: 'ATTACK_BUFF', targetType: 'SELF',
  },
  crisis_barrier: {
    id: 'crisis_barrier', name: '위기 방벽', rarity: '레어', roleTags: ['솔로', '탱커'],
    manaCost: 0, cooldownTurns: 5, duration: 3, maxHealthCoefficient: 0.22,
    type: 'SHIELD', targetType: 'SELF',
  },
  lone_wolf: {
    id: 'lone_wolf', name: '고독한 늑대', rarity: '전설', roleTags: ['솔로'],
    manaCost: 0, cooldownTurns: 6, duration: 3, requiresSolo: true,
    statPercentModifiers: { attack: 25, magicAttack: 25, defense: 25, speed: 15 },
    type: 'VERSATILE_BUFF', targetType: 'SELF',
  },
  last_survivor: {
    id: 'last_survivor', name: '최후의 생존자', rarity: '전설', roleTags: ['솔로'],
    manaCost: 0, oncePerBattle: true, missingHealthCoefficient: 0.5,
    cleanseCount: 99, shieldMaxHealthCoefficient: 0.15, duration: 3,
    type: 'HEAL', targetType: 'SELF',
  },
  shield_bash: {
    id: 'shield_bash', name: '방패 강타', rarity: '일반', roleTags: ['탱커', '솔로'],
    manaCost: 0, cooldownTurns: 2, defenseCoefficient: 0.9,
    type: 'ATTACK', targetType: 'ENEMY', scalingStat: 'defense', damageType: 'PHYSICAL',
    enemyDebuff: { attackReductionPercent: 5, duration: 1 },
  },
  inspiring_song: {
    id: 'inspiring_song', name: '격려의 노래', rarity: '일반', roleTags: ['버퍼'],
    manaCost: 10, cooldownTurns: 3, duration: 2, buffPercent: 10,
    affectedStats: ['attack', 'magicAttack'], buffMode: 'PERCENT',
    type: 'ATTACK_BUFF', targetType: 'ALLY',
  },
  novice_aegis: {
    id: 'novice_aegis', name: '견습 수호막', rarity: '일반', roleTags: ['탱커', '솔로'],
    manaCost: 0, cooldownTurns: 3, duration: 2, defenseCoefficient: 0.8,
    type: 'SHIELD', targetType: 'SELF', scalingStat: 'defense',
  },
  siphon_spark: {
    id: 'siphon_spark', name: '흡마의 불꽃', rarity: '일반', roleTags: ['마법 딜러', '솔로'],
    manaCost: 6, cooldownTurns: 2, magicAttackCoefficient: 0.85, manaRestoreFlat: 4,
    type: 'ATTACK', targetType: 'ENEMY', scalingStat: 'magicAttack', damageType: 'MAGICAL',
  },
  protective_guard: {
    id: 'protective_guard', name: '대신 막기', rarity: '고급', roleTags: ['탱커'],
    manaCost: 0, cooldownTurns: 4, duration: 2, damageReductionPercent: 30,
    type: 'DAMAGE_REDUCTION_BUFF', targetType: 'ALLY',
  },
  field_treatment: {
    id: 'field_treatment', name: '전장 응급술', rarity: '고급', roleTags: ['힐러'],
    manaCost: 18, cooldownTurns: 3, magicAttackCoefficient: 0.4,
    type: 'HEAL', targetType: 'PARTY', scalingStat: 'magicAttack',
  },
  elemental_exposure: {
    id: 'elemental_exposure', name: '원소 노출', rarity: '고급', roleTags: ['디버퍼', '마법 딜러'],
    manaCost: 16, cooldownTurns: 3, duration: 2, type: 'ENEMY_DEBUFF', targetType: 'ENEMY',
    enemyDebuff: { magicDefenseReductionPercent: 20, damageTakenIncreasePercent: 10 },
  },
  rallying_banner: {
    id: 'rallying_banner', name: '결집의 깃발', rarity: '레어', roleTags: ['버퍼', '탱커'],
    manaCost: 26, cooldownTurns: 5, duration: 3,
    statPercentModifiers: { defense: 15, speed: 10 },
    type: 'VERSATILE_BUFF', targetType: 'PARTY',
  },
};

export function getSkill(skillId) {
  return skillCatalog[skillId];
}

export function getSkillManaCost(skill) {
  return Math.max(0, Number(skill?.manaCost ?? 0));
}

export function getSkillScalingStat(skill) {
  if (skill?.scalingStat) return skill.scalingStat;
  if (skill?.defenseCoefficient !== undefined) return 'defense';
  return skill?.attackCoefficient !== undefined ? 'attack' : 'magicAttack';
}

export function getSkillCoefficient(skill) {
  return Number(skill?.attackCoefficient ?? skill?.magicAttackCoefficient ?? skill?.defenseCoefficient ?? 0);
}

export function calculateSkillPower(skill, stats) {
  const stat = getSkillScalingStat(skill);
  return Math.max(1, Math.round(Math.max(0, Number(stats?.[stat] ?? 0)) * getSkillCoefficient(skill)));
}

export function rollSkillFragment(source, random = Math.random) {
  const config = skillFragmentDropConfig[source];
  if (!config) return null;
  if (config.chance < 1 && random() >= config.chance) return null;
  const totalWeight = Object.values(config.weights).reduce((total, weight) => total + weight, 0);
  let roll = random() * totalWeight;
  for (const rarity of skillRarities) {
    roll -= config.weights[rarity] ?? 0;
    if (roll < 0) return rarity;
  }
  return skillRarities.at(-1);
}

export function calculateSkillHealing(skill, magicAttack) {
  return Math.max(1, Math.round(Math.max(0, magicAttack) * Number(skill.magicAttackCoefficient ?? 0)));
}

export function calculateSkillAttackPower(skill, magicAttack) {
  return Math.max(1, Math.round(Math.max(0, magicAttack) * Number(skill.magicAttackCoefficient ?? 0)));
}

export function getSkillCostText(skill) {
  const parts = [];
  const manaCost = getSkillManaCost(skill);
  parts.push(manaCost > 0 ? `마나 ${manaCost}` : '마나 소모 없음');
  if (skill.oncePerBattle) parts.push('전투당 1회');
  else if (skill.cooldownTurns) parts.push(`재사용 ${skill.cooldownTurns}턴`);
  return parts.join(' · ');
}

function describeEnemyDebuff(skill) {
  const debuff = skill.enemyDebuff ?? {};
  const effects = [];
  if (debuff.attackReductionPercent) effects.push(`적 공격력 -${debuff.attackReductionPercent}%`);
  if (debuff.defenseReductionPercent) effects.push(`적 방어력 -${debuff.defenseReductionPercent}%`);
  if (debuff.magicDefenseReductionPercent) effects.push(`적 마법 방어력 -${debuff.magicDefenseReductionPercent}%`);
  if (debuff.speedReductionPercent) effects.push(`적 속도 -${debuff.speedReductionPercent}%`);
  if (debuff.damageTakenIncreasePercent) effects.push(`적 받는 피해 +${debuff.damageTakenIncreasePercent}%`);
  if (debuff.actionDelayPercent) effects.push(`적 행동 게이지 ${debuff.actionDelayPercent}% 지연`);
  return effects.join(' · ');
}

export function describeSkillEffect(skill) {
  const coefficient = getSkillCoefficient(skill);
  const scaleName = ({ attack: '공격력', magicAttack: '마법 공격력', defense: '방어력' })[getSkillScalingStat(skill)] ?? '마법 공격력';
  const targetName = skill.targetType === 'PARTY' ? '파티 전체' : skill.targetType === 'SELF' ? '자신' : '아군 1명';
  if (skill.type === 'ATTACK') {
    const hitText = skill.hitCount > 1 ? ` × ${skill.hitCount}회` : '';
    const extras = [];
    if (skill.lifeStealRatio) extras.push(`실제 피해의 ${Math.round(skill.lifeStealRatio * 100)}% 회복`);
    if (skill.executeThreshold) extras.push(`적 체력 ${Math.round(skill.executeThreshold * 100)}% 이하 최종 피해 +${Math.round((skill.executeDamageMultiplier - 1) * 100)}%`);
    if (skill.enemyDebuff) extras.push(`${describeEnemyDebuff(skill)} (${skill.enemyDebuff.duration ?? skill.duration}턴)`);
    if (skill.manaRestoreFlat) extras.push(`마나 ${skill.manaRestoreFlat} 회복`);
    return `${scaleName} × ${coefficient}${hitText} ${skill.damageType === 'PHYSICAL' ? '물리' : '마법'} 피해${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
  }
  if (skill.type === 'HEAL') {
    const extras = [];
    if (skill.cleanseCount) extras.push(`디버프 ${skill.cleanseCount >= 99 ? '모두' : `${skill.cleanseCount}개`} 정화`);
    if (skill.shieldCoefficient) extras.push(`마법 공격력 × ${skill.shieldCoefficient} 보호막`);
    if (skill.shieldMaxHealthCoefficient) extras.push(`최대 체력 × ${skill.shieldMaxHealthCoefficient} 보호막`);
    const healing = skill.missingHealthCoefficient
      ? `잃은 체력의 ${Math.round(skill.missingHealthCoefficient * 100)}% 회복`
      : skill.maxHealthCoefficient
        ? `최대 체력의 ${Math.round(skill.maxHealthCoefficient * 100)}% 회복`
        : `마법 공격력 × ${skill.magicAttackCoefficient} 회복`;
    return `${targetName} ${healing}${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
  }
  if (skill.type === 'REGEN') {
    const healing = skill.maxHealthCoefficient
      ? `최대 체력의 ${Math.round(skill.maxHealthCoefficient * 100)}%`
      : `마법 공격력 × ${skill.magicAttackCoefficient}`;
    return `${targetName} 턴 시작마다 ${healing} 회복 (${skill.duration}턴)`;
  }
  if (skill.type === 'SHIELD') {
    const shield = skill.maxHealthCoefficient
      ? `최대 체력 × ${skill.maxHealthCoefficient}`
      : `${scaleName} × ${coefficient}`;
    return `${targetName} ${shield} 보호막 (${skill.duration}턴)`;
  }
  if (skill.type === 'ATTACK_BUFF') {
    const amount = skill.buffMode === 'PERCENT' ? `${skill.buffPercent}%` : `${scaleName} × ${coefficient}`;
    return `${targetName} 공격력·마법 공격력 +${amount} (${skill.duration}턴)`;
  }
  if (skill.type === 'DEFENSE_BUFF') return `${targetName} 방어력 +${scaleName} × ${coefficient} (${skill.duration}턴)`;
  if (skill.type === 'DAMAGE_REDUCTION_BUFF') return `${targetName}이 받는 피해 ${skill.damageReductionPercent}% 감소 (${skill.duration}턴)`;
  if (skill.type === 'SPEED_BUFF') return `${targetName} 속도 +${skill.speedIncreasePercent}% (${skill.duration}턴)`;
  if (skill.type === 'CRITICAL_BUFF') return `자신의 치명타 확률 +${skill.criticalChanceIncrease}% (${skill.duration}턴)`;
  if (skill.type === 'MANA_RESTORE') return `자신의 최대 마나 ${Math.round(skill.restoreManaRatio * 100)}% 회복`;
  if (skill.type === 'VERSATILE_BUFF') {
    const modifiers = Object.entries(skill.statPercentModifiers ?? {})
      .map(([stat, value]) => `${({ attack: '공격', magicAttack: '마공', defense: '방어', speed: '속도' })[stat] ?? stat} +${value}%`)
      .join(' · ');
    return `${targetName} ${modifiers} (${skill.duration}턴)`;
  }
  if (skill.type === 'TAUNT') {
    const extra = skill.damageReductionPercent ? ` · 받는 피해 ${skill.damageReductionPercent}% 감소 · 치명 피해 1회 생존` : '';
    return `적 공격 대상을 시전자로 고정 (${skill.duration} 적 턴)${extra}`;
  }
  if (skill.type === 'ENEMY_DEBUFF') return `${describeEnemyDebuff(skill)} (${skill.enemyDebuff?.duration ?? skill.duration} 적 턴)`;
  return '효과 정보 없음';
}

export function getRecommendedStats(skill) {
  const recommendations = [];
  const add = (...stats) => {
    for (const stat of stats) if (!recommendations.includes(stat)) recommendations.push(stat);
  };
  const roles = new Set(skill.roleTags ?? []);
  const scalingStat = getSkillScalingStat(skill);
  const hasScalingCoefficient = [
    skill.attackCoefficient,
    skill.magicAttackCoefficient,
    skill.defenseCoefficient,
  ].some((value) => value !== undefined);
  if (hasScalingCoefficient && scalingStat === 'attack') add('공격력');
  if (hasScalingCoefficient && scalingStat === 'magicAttack') add('마법 공격력');
  if (hasScalingCoefficient && scalingStat === 'defense') add('방어력', '체력');
  if (roles.has('탱커')) add('방어력', '체력');
  if (roles.has('힐러')) add('마법 공격력', '마나');
  if (roles.has('버퍼')) add('마법 공격력', '마나', '속도');
  if (roles.has('물리 딜러')) add('공격력', '치명타 확률', '치명타 피해');
  if (roles.has('마법 딜러')) add('마법 공격력', '마나', '치명타 확률');
  if (roles.has('하이브리드 딜러')) add('공격력', '마법 공격력', '치명타 확률');
  if (roles.has('디버퍼')) add('마나', '속도');
  if (roles.has('솔로') && recommendations.length < 3) add('체력', '방어력');
  return recommendations.slice(0, 4);
}

export function formatSkill(skill) {
  const roles = skill.roleTags?.length
    ? `${skill.roleTags.join('·')} 역할에 이 스킬이 어울립니다.`
    : '여러 역할에서 활용할 수 있습니다.';
  const soloRule = skill.roleTags?.includes('솔로')
    ? skill.requiresSolo
      ? '혼자 모험할 때만 사용할 수 있습니다.'
      : '혼자 모험할 때 100%, 파티에서는 효과가 50%로 감소합니다.'
    : null;
  const recommendedStats = getRecommendedStats(skill);
  const recommendation = recommendedStats.length > 0
    ? `${recommendedStats.join('·')} 중심으로 올리는 것을 추천합니다.`
    : null;
  return [
    `[${skill.rarity}] ${skill.name}`,
    roles,
    getSkillCostText(skill),
    describeSkillEffect(skill),
    recommendation,
    soloRule,
  ].filter(Boolean).join(' · ');
}
