import { randomUUID } from 'node:crypto';

export const equipmentSlots = ['머리', '상의', '하의', '신발', '무기'];

export const equipmentNamesByRarity = {
  일반: {
    머리: '낡은 가죽 모자',
    상의: '낡은 가죽 상의',
    하의: '낡은 가죽 하의',
    신발: '낡은 가죽 장화',
    무기: '낡은 철검',
  },
  고급: {
    머리: '평범한 철 모자',
    상의: '평범한 철 상의',
    하의: '평범한 철 하의',
    신발: '평범한 철 장화',
    무기: '평범한 철검',
  },
  레어: {
    머리: '빛나는 모자',
    상의: '빛나는 상의',
    하의: '빛나는 하의',
    신발: '빛나는 신발',
    무기: '빛나는 블레이드',
  },
  전설: {
    머리: '전설적인 모자',
    상의: '전설적인 상의',
    하의: '전설적인 하의',
    신발: '전설적인 신발',
    무기: '전설적인 마검',
  },
};

export const rarityRules = {
  일반: { maxEnhancement: 1, dismantleMagicStones: 1, color: 0x95a5a6 },
  고급: { maxEnhancement: 2, dismantleMagicStones: 2, color: 0x2ecc71 },
  레어: { maxEnhancement: 3, dismantleMagicStones: 3, color: 0x3498db },
  전설: { maxEnhancement: 4, dismantleMagicStones: 4, color: 0xf1c40f },
};

export const mainOptionRules = {
  머리: [{ stat: 'mana', label: '마나', baseValue: 20 }],
  상의: [{ stat: 'defense', label: '방어력', baseValue: 5 }],
  하의: [{ stat: 'health', label: '체력', baseValue: 50 }],
  신발: [{ stat: 'speed', label: '속도', baseValue: 5 }],
  무기: [
    { stat: 'attack', label: '공격력', baseValue: 10 },
    { stat: 'magicAttack', label: '마법 공격력', baseValue: 10 },
  ],
};

export const subOptionPool = [
  { stat: 'criticalChance', label: '치명타 확률', min: 4.9, max: 10.4, operation: 'PERCENT_POINT', decimals: 1 },
  { stat: 'criticalDamage', label: '치명타 피해', min: 9.8, max: 20.4, operation: 'PERCENT_POINT', decimals: 1 },
  { stat: 'attack', label: '공격력', min: 5.2, max: 15, operation: 'MULTIPLIER', decimals: 1 },
  { stat: 'magicAttack', label: '마법 공격력', min: 5.2, max: 15, operation: 'MULTIPLIER', decimals: 1 },
  { stat: 'defense', label: '방어력', min: 6.6, max: 16.9, operation: 'MULTIPLIER', decimals: 1 },
  { stat: 'health', label: '체력', min: 5.2, max: 15, operation: 'MULTIPLIER', decimals: 1 },
  { stat: 'mana', label: '마나', min: 5.2, max: 15, operation: 'FLAT', decimals: 1 },
  { stat: 'speed', label: '속도', min: 2, max: 11, operation: 'FLAT', decimals: 0 },
];

const MAIN_OPTION_GROWTH_PER_ITEM_LEVEL = 0.08;

function rollValue(min, max, decimals, random = Math.random) {
  const scale = 10 ** decimals;
  return Math.round((min + random() * (max - min)) * scale) / scale;
}

export function rollSubOption(rule, random = Math.random) {
  return {
    stat: rule.stat,
    label: rule.label,
    value: rollValue(rule.min, rule.max, rule.decimals, random),
    operation: rule.operation,
  };
}

function normalizeSubOptions(item) {
  item.subOptions ??= [];
  item.subOptions = item.subOptions.map((option) => {
    const rule = subOptionPool.find((candidate) => candidate.stat === option.stat);
    if (!rule) return option;
    if (option.value === undefined || option.operation === undefined) return rollSubOption(rule);
    return {
      stat: rule.stat,
      label: rule.label,
      value: option.value,
      operation: rule.operation,
    };
  });
}

export function getScaledMainOptionBase(baseValue, itemLevel) {
  const normalizedItemLevel = Math.max(1, Math.floor(itemLevel));
  const multiplier = 1 + (normalizedItemLevel - 1) * MAIN_OPTION_GROWTH_PER_ITEM_LEVEL;
  return Math.round(baseValue * multiplier * 10) / 10;
}

export function normalizeEquipmentMainOptions(item) {
  const rules = mainOptionRules[item.slot];
  if (!rules) return item;
  item.itemLevel = Math.max(1, Math.floor(item.itemLevel ?? 1));
  item.locked ??= false;
  item.enhancement = Math.max(0, Math.min(item.enhancement ?? 0, getMaxEnhancement(item)));
  item.mainOptions = rules.map((rule) => {
    const baseValue = getScaledMainOptionBase(rule.baseValue, item.itemLevel);
    return {
      stat: rule.stat,
      label: rule.label,
      baseValue,
      value: Math.round(baseValue * (1 + item.enhancement * 0.2) * 10) / 10,
    };
  });
  normalizeSubOptions(item);
  return item;
}

export function createEquipment({ name, itemLevel, rarity, slot }) {
  if (!equipmentSlots.includes(slot)) throw new Error(`알 수 없는 장비 부위: ${slot}`);
  if (!rarityRules[rarity]) throw new Error(`알 수 없는 장비 등급: ${rarity}`);

  return normalizeEquipmentMainOptions({
    id: randomUUID(),
    name,
    itemLevel: Math.max(1, Math.floor(itemLevel)),
    rarity,
    slot,
    enhancement: 0,
    mainOptions: [],
    subOptions: [],
  });
}

export function enhanceEquipment(item, random = Math.random) {
  const rule = rarityRules[item.rarity];
  if (!rule) throw new Error('장비 등급 정보가 올바르지 않습니다.');
  if (item.enhancement >= rule.maxEnhancement) return false;

  item.enhancement += 1;
  item.mainOptions = item.mainOptions.map((option) => ({
    ...option,
    value: Math.round(option.baseValue * (1 + item.enhancement * 0.2) * 10) / 10,
  }));

  const availableOptions = subOptionPool.filter(
    (candidate) => !item.subOptions.some((option) => option.stat === candidate.stat),
  );
  const newOption = availableOptions[Math.floor(random() * availableOptions.length)];
  item.subOptions.push(rollSubOption(newOption, random));

  return true;
}

export function getMaxEnhancement(item) {
  return rarityRules[item.rarity]?.maxEnhancement ?? 0;
}

export function getDismantleMagicStones(item) {
  const baseReward = rarityRules[item.rarity]?.dismantleMagicStones;
  if (baseReward === undefined) throw new Error(`알 수 없는 장비 등급: ${item.rarity}`);
  return baseReward + Math.max(0, Math.floor(item.enhancement ?? 0));
}

export function canEquipItem(playerLevel, item) {
  return Math.max(1, Math.floor(playerLevel)) >= Math.max(1, Math.floor(item.itemLevel ?? 1));
}

export function getEquipmentName(rarity, slot) {
  const name = equipmentNamesByRarity[rarity]?.[slot];
  if (!name) throw new Error(`장비 이름을 찾을 수 없습니다: ${rarity}/${slot}`);
  return name;
}

export function rollEquipmentRarity(floor, random = Math.random) {
  const normalizedFloor = Math.max(1, Math.floor(floor));
  const legendaryChance = Math.min(0.12, Math.max(0, normalizedFloor - 4) * 0.01);
  const rareChance = Math.min(0.28, 0.05 + (normalizedFloor - 1) * 0.015);
  const advancedChance = Math.min(0.35, 0.2 + (normalizedFloor - 1) * 0.01);
  const roll = random();
  if (roll < legendaryChance) return '전설';
  if (roll < legendaryChance + rareChance) return '레어';
  if (roll < legendaryChance + rareChance + advancedChance) return '고급';
  return '일반';
}

export function shouldDropEquipmentFromMonster(isMimic, random = Math.random) {
  return random() < (isMimic ? 0.7 : 0.3);
}

export function formatEquipmentName(item) {
  const enhancementStars = '⭐'.repeat(Math.max(0, Math.floor(item.enhancement ?? 0)));
  return `${item.locked ? '🔒 ' : ''}[${item.rarity}] ${item.name}${enhancementStars ? ` ${enhancementStars}` : ''}`;
}

export function formatEquipmentDetails(item) {
  const mainOptions = item.mainOptions
    .map((option) => `${option.label} +${option.value}`)
    .join(', ');
  const subOptions = item.subOptions.length
    ? item.subOptions
        .map((option) => `${option.label} +${option.value}${option.operation === 'FLAT' ? '' : '%'}`)
        .join(', ')
    : '없음';

  return [
    `${formatEquipmentName(item)} · ${item.slot} · 고유 레벨 ${item.itemLevel}`,
    `주옵션: ${mainOptions}`,
    `부옵션: ${subOptions}`,
  ].join('\n');
}

export function createStarterEquipment() {
  return [
    ...equipmentSlots.map((slot) =>
      createEquipment({
        name: getEquipmentName('일반', slot),
        itemLevel: 1,
        rarity: '일반',
        slot,
      }),
    ),
  ];
}

export function calculateTotalStats(player) {
  const total = { ...player.stats };
  const subOptions = [];

  for (const item of Object.values(player.equipment)) {
    if (!item) continue;

    for (const option of item.mainOptions) {
      total[option.stat] = (total[option.stat] ?? 0) + option.value;
    }

    for (const option of item.subOptions) {
      subOptions.push(option);
    }
  }

  for (const option of subOptions) {
    if (option.operation === 'MULTIPLIER') {
      total[option.stat] = (total[option.stat] ?? 0) * (1 + option.value / 100);
    } else {
      total[option.stat] = (total[option.stat] ?? 0) + option.value;
    }
  }
  for (const stat of Object.keys(total)) {
    if (typeof total[stat] === 'number') total[stat] = Math.round(total[stat] * 10) / 10;
  }

  return total;
}
