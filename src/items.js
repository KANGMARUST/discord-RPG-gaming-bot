export const potionCatalog = {
  common_health_potion: {
    id: 'common_health_potion',
    name: '일반체력포션',
    type: 'HEALTH',
    rarity: '일반',
    recoveryRatio: 0.05,
    price: 50,
  },
  advanced_health_potion: {
    id: 'advanced_health_potion',
    name: '고급체력포션',
    type: 'HEALTH',
    rarity: '고급',
    recoveryRatio: 0.1,
    price: 120,
  },
  rare_health_potion: {
    id: 'rare_health_potion',
    name: '레어체력포션',
    type: 'HEALTH',
    rarity: '레어',
    recoveryRatio: 0.25,
    price: 300,
  },
  legendary_health_potion: {
    id: 'legendary_health_potion',
    name: '전설체력포션',
    type: 'HEALTH',
    rarity: '전설',
    recoveryRatio: 0.5,
    price: 700,
  },
  common_mana_potion: {
    id: 'common_mana_potion',
    name: '일반마나포션',
    type: 'MANA',
    rarity: '일반',
    recoveryRatio: 0.05,
    price: 50,
  },
  advanced_mana_potion: {
    id: 'advanced_mana_potion',
    name: '고급마나포션',
    type: 'MANA',
    rarity: '고급',
    recoveryRatio: 0.1,
    price: 120,
  },
  rare_mana_potion: {
    id: 'rare_mana_potion',
    name: '레어마나포션',
    type: 'MANA',
    rarity: '레어',
    recoveryRatio: 0.25,
    price: 300,
  },
  legendary_mana_potion: {
    id: 'legendary_mana_potion',
    name: '전설마나포션',
    type: 'MANA',
    rarity: '전설',
    recoveryRatio: 0.5,
    price: 700,
  },
};

const rarityWeights = [
  { rarity: '일반', weight: 55 },
  { rarity: '고급', weight: 28 },
  { rarity: '레어', weight: 12 },
  { rarity: '전설', weight: 5 },
];

export function getPotion(itemId) {
  return potionCatalog[itemId];
}

export function getPotionDescription(potion) {
  const resource = potion.type === 'HEALTH' ? '최대 체력' : '최대 마나';
  return `${resource}의 ${potion.recoveryRatio * 100}% 회복`;
}

export function rollPotionDrop(source, random = Math.random) {
  const dropChance = source === 'TREASURE' ? 0.65 : 0.3;
  if (random() >= dropChance) return null;

  const rarityRoll = random() * 100;
  let cumulativeWeight = 0;
  let selectedRarity = '일반';
  for (const entry of rarityWeights) {
    cumulativeWeight += entry.weight;
    if (rarityRoll < cumulativeWeight) {
      selectedRarity = entry.rarity;
      break;
    }
  }

  const type = random() < 0.5 ? 'HEALTH' : 'MANA';
  return Object.values(potionCatalog).find(
    (potion) => potion.rarity === selectedRarity && potion.type === type,
  );
}
