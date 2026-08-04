export const MAX_EQUIPPED_SKILLS = 3;
export const STARTER_SKILL_IDS = ['magic_bolt', 'basic_heal'];

export const skillCatalog = {
  magic_bolt: {
    id: 'magic_bolt',
    name: '마력탄',
    rarity: '일반',
    manaCost: 8,
    magicAttackCoefficient: 1.1,
    type: 'ATTACK',
    targetType: 'ENEMY',
  },
  basic_heal: {
    id: 'basic_heal',
    name: '치유의 빛',
    rarity: '일반',
    manaCost: 8,
    magicAttackCoefficient: 0.7,
    type: 'HEAL',
    targetType: 'ALLY',
  },
  flame_spear: {
    id: 'flame_spear',
    name: '화염의 창',
    rarity: '고급',
    manaCost: 14,
    magicAttackCoefficient: 1.65,
    type: 'ATTACK',
    targetType: 'ENEMY',
  },
  advanced_heal: {
    id: 'advanced_heal',
    name: '상급 치유의 빛',
    rarity: '고급',
    manaCost: 14,
    magicAttackCoefficient: 1.25,
    type: 'HEAL',
    targetType: 'ALLY',
  },
  arcane_amplification: {
    id: 'arcane_amplification',
    name: '마력 증폭',
    rarity: '고급',
    manaCost: 16,
    magicAttackCoefficient: 0.35,
    duration: 3,
    type: 'ATTACK_BUFF',
    targetType: 'ALLY',
  },
  guardian_barrier: {
    id: 'guardian_barrier',
    name: '수호 결계',
    rarity: '고급',
    manaCost: 16,
    magicAttackCoefficient: 0.45,
    duration: 3,
    type: 'DEFENSE_BUFF',
    targetType: 'ALLY',
  },
  chain_lightning: {
    id: 'chain_lightning',
    name: '뇌광 폭발',
    rarity: '레어',
    manaCost: 22,
    magicAttackCoefficient: 2.4,
    type: 'ATTACK',
    targetType: 'ENEMY',
  },
  rare_heal: {
    id: 'rare_heal',
    name: '생명의 파동',
    rarity: '레어',
    manaCost: 22,
    magicAttackCoefficient: 2,
    type: 'HEAL',
    targetType: 'ALLY',
  },
  starfall: {
    id: 'starfall',
    name: '별무리 낙하',
    rarity: '전설',
    manaCost: 36,
    magicAttackCoefficient: 3.8,
    type: 'ATTACK',
    targetType: 'ENEMY',
  },
  legendary_heal: {
    id: 'legendary_heal',
    name: '성역의 기도',
    rarity: '전설',
    manaCost: 34,
    magicAttackCoefficient: 3.2,
    type: 'HEAL',
    targetType: 'ALLY',
  },
  guardian_taunt: {
    id: 'guardian_taunt',
    name: '수호자의 도발',
    rarity: '일반',
    manaCost: 10,
    duration: 3,
    type: 'TAUNT',
    targetType: 'ENEMY',
  },
};

export function getSkill(skillId) {
  return skillCatalog[skillId];
}

export function calculateSkillHealing(skill, magicAttack) {
  return Math.max(1, Math.round(Math.max(0, magicAttack) * skill.magicAttackCoefficient));
}

export function calculateSkillAttackPower(skill, magicAttack) {
  return Math.max(1, Math.round(Math.max(0, magicAttack) * skill.magicAttackCoefficient));
}

export function formatSkill(skill) {
  const effects = {
    ATTACK: `공격 계수: 마법 공격력 × ${skill.magicAttackCoefficient}`,
    HEAL: `회복 계수: 마법 공격력 × ${skill.magicAttackCoefficient}`,
    ATTACK_BUFF: `공격력·마법 공격력 증가: 마법 공격력 × ${skill.magicAttackCoefficient} (${skill.duration}턴)`,
    DEFENSE_BUFF: `방어력 증가: 마법 공격력 × ${skill.magicAttackCoefficient} (${skill.duration}턴)`,
    TAUNT: `적의 공격 대상을 시전자로 고정 (${skill.duration} 적 턴)`,
  };
  return [
    `[${skill.rarity}] ${skill.name}`,
    `필요 마나: ${skill.manaCost}`,
    effects[skill.type] ?? '효과 정보 없음',
  ].join(' · ');
}
