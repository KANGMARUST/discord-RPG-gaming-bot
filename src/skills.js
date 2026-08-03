export const MAX_EQUIPPED_SKILLS = 3;

export const skillCatalog = {
  basic_heal: {
    id: 'basic_heal',
    name: '치유의 빛',
    rarity: '일반',
    manaCost: 10,
    magicAttackCoefficient: 0.8,
    type: 'HEAL',
    targetType: 'ALLY',
  },
  advanced_heal: {
    id: 'advanced_heal',
    name: '상급 치유의 빛',
    rarity: '고급',
    manaCost: 16,
    magicAttackCoefficient: 1.4,
    type: 'HEAL',
    targetType: 'ALLY',
  },
  rare_heal: {
    id: 'rare_heal',
    name: '생명의 파동',
    rarity: '레어',
    manaCost: 24,
    magicAttackCoefficient: 2.2,
    type: 'HEAL',
    targetType: 'ALLY',
  },
  legendary_heal: {
    id: 'legendary_heal',
    name: '성역의 기도',
    rarity: '전설',
    manaCost: 35,
    magicAttackCoefficient: 3.5,
    type: 'HEAL',
    targetType: 'ALLY',
  },
};

export function getSkill(skillId) {
  return skillCatalog[skillId];
}

export function calculateSkillHealing(skill, magicAttack) {
  return Math.max(1, Math.round(Math.max(0, magicAttack) * skill.magicAttackCoefficient));
}

export function formatSkill(skill) {
  return [
    `[${skill.rarity}] ${skill.name}`,
    `필요 마나: ${skill.manaCost}`,
    `회복 계수: 마법 공격력 × ${skill.magicAttackCoefficient}`,
  ].join(' · ');
}
