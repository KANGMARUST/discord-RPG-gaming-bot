import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createStarterEquipment,
  equipmentSlots,
  getMaxEnhancement,
  getDismantleMagicStones,
  canEquipItem,
  normalizeEquipmentMainOptions,
} from './equipment.js';
import { getPotion, getPotionDescription } from './items.js';
import { grantExperienceToPlayer } from './leveling.js';
import { getSkill, MAX_EQUIPPED_SKILLS, STARTER_SKILL_IDS } from './skills.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.join(currentDirectory, '..', 'data');
const playersFile = path.join(dataDirectory, 'players.json');
const equipmentRarityPriority = { 일반: 1, 고급: 2, 레어: 3, 전설: 4 };

export function compareAutoEquipPriority(left, right) {
  return (
    right.itemLevel - left.itemLevel ||
    (equipmentRarityPriority[right.rarity] ?? 0) -
      (equipmentRarityPriority[left.rarity] ?? 0) ||
    (right.enhancement ?? 0) - (left.enhancement ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

export function matchesBulkDismantleFilter(
  item,
  { maxItemLevel = null, maxRarity = null } = {},
) {
  const rarityPriority = { 일반: 1, 고급: 2, 레어: 3, 전설: 4 };
  const maxRarityPriority = maxRarity ? rarityPriority[maxRarity] : null;
  const levelMatches = maxItemLevel === null || item.itemLevel <= maxItemLevel;
  const rarityMatches = maxRarityPriority === null ||
    (rarityPriority[item.rarity] ?? Number.POSITIVE_INFINITY) <= maxRarityPriority;
  return levelMatches && rarityMatches;
}

function createPlayer(userId) {
  return {
    userId,
    stats: {
      playerLevel: 1,
      health: 70,
      defense: 5,
      attack: 10,
      magicAttack: 10,
      mana: 50,
      speed: 10,
      criticalChance: 5,
      criticalDamage: 150,
    },
    equipment: Object.fromEntries(equipmentSlots.map((slot) => [slot, null])),
    equipmentInventory: {
      equipment: createStarterEquipment(),
      materials: { 마석: 0 },
    },
    itemInventory: [],
    gold: 0,
    experience: 0,
    skillInventory: [...STARTER_SKILL_IDS],
    equippedSkills: ['magic_bolt', 'basic_heal', null],
    balanceVersion: 1,
    checkpointFloor: 1,
    maxReachedFloor: 1,
    createdAt: new Date().toISOString(),
  };
}

class PlayerStore {
  constructor() {
    this.players = {};
    this.ready = this.load();
    this.saveQueue = Promise.resolve();
  }

  migratePlayer(player) {
    const defaults = createPlayer(player.userId);
    player.stats = { ...defaults.stats, ...player.stats };
    if ((player.balanceVersion ?? 0) < 1) {
      const completedLevelUps = Math.max(0, player.stats.playerLevel - 1);
      player.stats.health = Math.max(1, player.stats.health - 30 - completedLevelUps * 4);
      player.balanceVersion = 1;
    }
    player.equipment = { ...defaults.equipment, ...player.equipment };
    if (!player.equipmentInventory) {
      player.equipmentInventory = {
        equipment: Array.isArray(player.inventory)
          ? player.inventory
          : defaults.equipmentInventory.equipment,
        materials: { 마석: 0 },
      };
    }
    player.equipmentInventory.equipment ??= [];
    for (const item of Object.values(player.equipment)) {
      if (item) normalizeEquipmentMainOptions(item);
    }
    for (const item of player.equipmentInventory.equipment) {
      normalizeEquipmentMainOptions(item);
    }
    player.equipmentInventory.materials = {
      마석: 0,
      ...player.equipmentInventory.materials,
    };
    player.itemInventory ??= [];
    delete player.inventory;
    player.gold ??= 0;
    player.experience ??= 0;
    player.skillInventory ??= [...defaults.skillInventory];
    for (const skillId of STARTER_SKILL_IDS) {
      if (!player.skillInventory.includes(skillId)) player.skillInventory.push(skillId);
    }
    player.equippedSkills ??= [...defaults.equippedSkills];
    player.equippedSkills = Array.from(
      { length: MAX_EQUIPPED_SKILLS },
      (_, index) => player.equippedSkills[index] ?? null,
    );
    player.balanceVersion ??= defaults.balanceVersion;
    player.checkpointFloor ??= 1;
    player.maxReachedFloor = Math.max(
      player.checkpointFloor,
      Math.max(1, Math.floor(player.maxReachedFloor ?? 1)),
    );
    return player;
  }

  async load() {
    await mkdir(dataDirectory, { recursive: true });

    try {
      this.players = JSON.parse(await readFile(playersFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(playersFile, '{}\n', 'utf8');
    }
  }

  async getOrCreate(userId) {
    await this.ready;

    if (!this.players[userId]) {
      this.players[userId] = createPlayer(userId);
      await this.save();
    }

    const player = this.migratePlayer(this.players[userId]);
    await this.save();
    return player;
  }

  async getAllPlayers() {
    await this.ready;
    const players = Object.values(this.players).map((player) => this.migratePlayer(player));
    await this.save();
    return players;
  }

  async equipItem(userId, itemName) {
    const player = await this.getOrCreate(userId);
    const normalizedName = itemName.trim().toLocaleLowerCase('ko-KR');
    const itemIndex = player.equipmentInventory.equipment.findIndex(
      (item) =>
        item.id === itemName || item.name.toLocaleLowerCase('ko-KR') === normalizedName,
    );

    if (itemIndex === -1) return { ok: false, reason: 'NOT_FOUND' };

    const selectedItem = player.equipmentInventory.equipment[itemIndex];
    if (!canEquipItem(player.stats.playerLevel, selectedItem)) {
      return {
        ok: false,
        reason: 'LEVEL_TOO_LOW',
        item: selectedItem,
        playerLevel: player.stats.playerLevel,
        requiredLevel: selectedItem.itemLevel,
      };
    }

    const [item] = player.equipmentInventory.equipment.splice(itemIndex, 1);
    const previousItem = player.equipment[item.slot];
    player.equipment[item.slot] = item;
    if (previousItem) player.equipmentInventory.equipment.push(previousItem);
    await this.save();

    return { ok: true, item, previousItem };
  }

  async autoEquipBest(userId) {
    const player = await this.getOrCreate(userId);
    const allEquipment = [
      ...player.equipmentInventory.equipment,
      ...Object.values(player.equipment).filter(Boolean),
    ];
    const playerLevel = player.stats.playerLevel;
    const equippableEquipment = allEquipment.filter((item) => canEquipItem(playerLevel, item));
    const skippedEquipment = allEquipment.filter((item) => !canEquipItem(playerLevel, item));
    const selectedBySlot = {};

    for (const slot of equipmentSlots) {
      selectedBySlot[slot] = equippableEquipment
        .filter((item) => item.slot === slot)
        .sort(compareAutoEquipPriority)[0] ?? null;
    }

    const changes = equipmentSlots
      .map((slot) => ({
        slot,
        previousItem: player.equipment[slot],
        item: selectedBySlot[slot],
      }))
      .filter(({ previousItem, item }) => previousItem?.id !== item?.id);
    const selectedIds = new Set(Object.values(selectedBySlot).filter(Boolean).map((item) => item.id));
    player.equipment = { ...selectedBySlot };
    player.equipmentInventory.equipment = allEquipment.filter((item) => !selectedIds.has(item.id));
    await this.save();
    return {
      changes,
      equipment: player.equipment,
      playerLevel,
      skippedEquipment,
    };
  }

  async enhanceInventoryItem(userId, itemName, enhanceFunction) {
    const player = await this.getOrCreate(userId);
    const normalizedName = itemName.trim().toLocaleLowerCase('ko-KR');
    let item = player.equipmentInventory.equipment.find(
      (candidate) =>
        candidate.id === itemName ||
        candidate.name.toLocaleLowerCase('ko-KR') === normalizedName,
    );
    let equippedSlot = null;
    if (!item) {
      const equippedEntry = Object.entries(player.equipment).find(
        ([, candidate]) =>
          candidate &&
          (candidate.id === itemName || candidate.name.toLocaleLowerCase('ko-KR') === normalizedName),
      );
      if (equippedEntry) [equippedSlot, item] = equippedEntry;
    }

    if (!item) return { ok: false, reason: 'NOT_FOUND' };
    if (item.enhancement >= getMaxEnhancement(item)) {
      return { ok: false, reason: 'MAX', item };
    }

    const requiredMagicStones = item.enhancement + 1;
    const ownedMagicStones = player.equipmentInventory.materials.마석;
    if (ownedMagicStones < requiredMagicStones) {
      return {
        ok: false,
        reason: 'NOT_ENOUGH_MAGIC_STONES',
        item,
        requiredMagicStones,
        ownedMagicStones,
      };
    }

    if (!enhanceFunction(item)) return { ok: false, reason: 'MAX', item };
    player.equipmentInventory.materials.마석 -= requiredMagicStones;
    await this.save();
    return {
      ok: true,
      item,
      usedMagicStones: requiredMagicStones,
      remainingMagicStones: player.equipmentInventory.materials.마석,
      equippedSlot,
    };
  }

  async dismantleEquipment(userId, itemIdentifier) {
    const player = await this.getOrCreate(userId);
    const normalizedIdentifier = itemIdentifier.trim().toLocaleLowerCase('ko-KR');
    const itemIndex = player.equipmentInventory.equipment.findIndex(
      (item) =>
        item.id === itemIdentifier ||
        item.name.toLocaleLowerCase('ko-KR') === normalizedIdentifier,
    );
    if (itemIndex === -1) return { ok: false, reason: 'NOT_FOUND' };

    const selectedItem = player.equipmentInventory.equipment[itemIndex];
    if (selectedItem.locked) return { ok: false, reason: 'LOCKED', item: selectedItem };

    const [item] = player.equipmentInventory.equipment.splice(itemIndex, 1);
    const magicStones = getDismantleMagicStones(item);
    player.equipmentInventory.materials.마석 += magicStones;
    await this.save();
    return {
      ok: true,
      item,
      magicStones,
      totalMagicStones: player.equipmentInventory.materials.마석,
    };
  }

  async dismantleEquipmentBulk(userId, { maxItemLevel = null, maxRarity = null } = {}) {
    const player = await this.getOrCreate(userId);
    const rarityPriority = { 일반: 1, 고급: 2, 레어: 3, 전설: 4 };
    const maxRarityPriority = maxRarity ? rarityPriority[maxRarity] : null;
    if (maxItemLevel === null && maxRarityPriority === null) {
      return { ok: false, reason: 'NO_FILTER' };
    }

    const matched = [];
    const kept = [];
    let lockedExcluded = 0;
    for (const item of player.equipmentInventory.equipment) {
      if (matchesBulkDismantleFilter(item, { maxItemLevel, maxRarity })) {
        if (item.locked) {
          lockedExcluded += 1;
          kept.push(item);
        } else {
          matched.push(item);
        }
      } else {
        kept.push(item);
      }
    }
    if (matched.length === 0) {
      return { ok: false, reason: 'NOT_FOUND', lockedExcluded };
    }

    const magicStones = matched.reduce(
      (total, item) => total + getDismantleMagicStones(item),
      0,
    );
    player.equipmentInventory.equipment = kept;
    player.equipmentInventory.materials.마석 += magicStones;
    await this.save();
    return {
      ok: true,
      dismantledCount: matched.length,
      magicStones,
      totalMagicStones: player.equipmentInventory.materials.마석,
      lockedExcluded,
    };
  }

  async setEquipmentLock(userId, itemIdentifier, locked) {
    const player = await this.getOrCreate(userId);
    const allEquipment = [
      ...player.equipmentInventory.equipment,
      ...Object.values(player.equipment).filter(Boolean),
    ];
    const normalizedIdentifier = itemIdentifier.trim().toLocaleLowerCase('ko-KR');
    const item = allEquipment.find(
      (candidate) =>
        candidate.id === itemIdentifier ||
        candidate.name.toLocaleLowerCase('ko-KR') === normalizedIdentifier,
    );
    if (!item) return { ok: false, reason: 'NOT_FOUND' };
    item.locked = locked;
    await this.save();
    return { ok: true, item, locked };
  }

  async equipSkill(userId, skillId, slot) {
    const player = await this.getOrCreate(userId);
    const skill = getSkill(skillId);
    if (!skill || !player.skillInventory.includes(skillId)) {
      return { ok: false, reason: 'NOT_OWNED' };
    }
    const slotIndex = Number(slot) - 1;
    if (slotIndex < 0 || slotIndex >= MAX_EQUIPPED_SKILLS) {
      return { ok: false, reason: 'INVALID_SLOT' };
    }
    const duplicateSlot = player.equippedSkills.findIndex(
      (equippedSkillId, index) => equippedSkillId === skillId && index !== slotIndex,
    );
    if (duplicateSlot !== -1) player.equippedSkills[duplicateSlot] = null;
    const previousSkillId = player.equippedSkills[slotIndex];
    player.equippedSkills[slotIndex] = skillId;
    await this.save();
    return {
      ok: true,
      skill,
      slot: slotIndex + 1,
      previousSkill: previousSkillId ? getSkill(previousSkillId) : null,
    };
  }

  async unequipSkill(userId, slot) {
    const player = await this.getOrCreate(userId);
    const slotIndex = Number(slot) - 1;
    if (slotIndex < 0 || slotIndex >= MAX_EQUIPPED_SKILLS) {
      return { ok: false, reason: 'INVALID_SLOT' };
    }
    const skillId = player.equippedSkills[slotIndex];
    if (!skillId) return { ok: false, reason: 'EMPTY_SLOT', slot: slotIndex + 1 };
    player.equippedSkills[slotIndex] = null;
    await this.save();
    return { ok: true, skill: getSkill(skillId), slot: slotIndex + 1 };
  }

  async learnSkill(userId, skillId) {
    const player = await this.getOrCreate(userId);
    if (!getSkill(skillId)) return { ok: false, reason: 'NOT_FOUND' };
    if (!player.skillInventory.includes(skillId)) player.skillInventory.push(skillId);
    await this.save();
    return { ok: true, skill: getSkill(skillId) };
  }

  async addAdventureReward(userId, gold, equipmentItem) {
    const player = await this.getOrCreate(userId);
    player.gold += Math.max(0, Math.floor(gold));
    if (equipmentItem) player.equipmentInventory.equipment.push(equipmentItem);
    await this.save();
    return player;
  }

  async removeGold(userId, amount) {
    const player = await this.getOrCreate(userId);
    const requested = Math.max(0, Math.floor(amount));
    const removed = Math.min(player.gold, requested);
    player.gold -= removed;
    await this.save();
    return { removed, gold: player.gold };
  }

  async removeInventoryEquipmentByIds(userId, equipmentIds) {
    const player = await this.getOrCreate(userId);
    const idSet = new Set(equipmentIds);
    const removed = player.equipmentInventory.equipment.filter((item) => idSet.has(item.id));
    player.equipmentInventory.equipment = player.equipmentInventory.equipment.filter(
      (item) => !idSet.has(item.id),
    );
    await this.save();
    return removed;
  }

  async addDebugResources(userId, { gold = 0, magicStones = 0 } = {}) {
    const player = await this.getOrCreate(userId);
    player.gold += Math.max(0, Math.floor(gold));
    player.equipmentInventory.materials.마석 += Math.max(0, Math.floor(magicStones));
    await this.save();
    return player;
  }

  async addItem(userId, itemId, quantity = 1) {
    const potion = getPotion(itemId);
    if (!potion) throw new Error(`알 수 없는 아이템: ${itemId}`);
    const player = await this.getOrCreate(userId);
    const existingItem = player.itemInventory.find((item) => item.id === itemId);
    if (existingItem) existingItem.quantity += quantity;
    else {
      player.itemInventory.push({
        id: potion.id,
        name: potion.name,
        description: getPotionDescription(potion),
        quantity,
      });
    }
    await this.save();
    return player;
  }

  async buyItem(userId, itemId) {
    const potion = getPotion(itemId);
    if (!potion) return { ok: false, reason: 'NOT_FOUND' };
    const player = await this.getOrCreate(userId);
    if (player.gold < potion.price) {
      return { ok: false, reason: 'NOT_ENOUGH_GOLD', potion, gold: player.gold };
    }
    player.gold -= potion.price;
    const existingItem = player.itemInventory.find((item) => item.id === itemId);
    if (existingItem) existingItem.quantity += 1;
    else {
      player.itemInventory.push({
        id: potion.id,
        name: potion.name,
        description: getPotionDescription(potion),
        quantity: 1,
      });
    }
    await this.save();
    return { ok: true, potion, gold: player.gold, quantity: existingItem?.quantity ?? 1 };
  }

  async sellItem(userId, itemId) {
    const potion = getPotion(itemId);
    if (!potion) return { ok: false, reason: 'NOT_FOUND' };
    const player = await this.getOrCreate(userId);
    const itemIndex = player.itemInventory.findIndex(
      (item) => item.id === itemId && item.quantity > 0,
    );
    if (itemIndex === -1) return { ok: false, reason: 'NOT_OWNED', potion, gold: player.gold };
    const salePrice = Math.max(1, Math.floor(potion.price * 0.5));
    const item = player.itemInventory[itemIndex];
    item.quantity -= 1;
    const remaining = item.quantity;
    if (item.quantity === 0) player.itemInventory.splice(itemIndex, 1);
    player.gold += salePrice;
    await this.save();
    return { ok: true, potion, salePrice, remaining, gold: player.gold };
  }

  async buyMagicStone(userId, price = 500) {
    const player = await this.getOrCreate(userId);
    if (player.gold < price) {
      return { ok: false, reason: 'NOT_ENOUGH_GOLD', price, gold: player.gold };
    }
    player.gold -= price;
    player.equipmentInventory.materials.마석 += 1;
    await this.save();
    return {
      ok: true,
      price,
      gold: player.gold,
      magicStones: player.equipmentInventory.materials.마석,
    };
  }

  async consumeItem(userId, itemId) {
    const player = await this.getOrCreate(userId);
    const itemIndex = player.itemInventory.findIndex(
      (item) => item.id === itemId && item.quantity > 0,
    );
    if (itemIndex === -1) return { ok: false, reason: 'NOT_OWNED' };
    const item = player.itemInventory[itemIndex];
    item.quantity -= 1;
    if (item.quantity === 0) player.itemInventory.splice(itemIndex, 1);
    await this.save();
    return { ok: true, remaining: item.quantity };
  }

  async grantMonsterExperience(userId, monsterLevel, rewardMultiplier = 1) {
    const player = await this.getOrCreate(userId);
    const result = grantExperienceToPlayer(player, monsterLevel, rewardMultiplier);
    await this.save();
    return result;
  }

  async unlockCheckpoint(userId, floor) {
    const player = await this.getOrCreate(userId);
    const normalizedFloor = Math.max(1, Math.floor(floor));
    const previousFloor = player.checkpointFloor;
    player.checkpointFloor = Math.max(player.checkpointFloor, normalizedFloor);
    await this.save();
    return {
      previousFloor,
      checkpointFloor: player.checkpointFloor,
      updated: player.checkpointFloor > previousFloor,
    };
  }

  async unlockCheckpointForUsers(userIds, floor) {
    await this.ready;
    const normalizedFloor = Math.max(1, Math.floor(floor));
    const results = [];
    for (const userId of [...new Set(userIds)]) {
      if (!this.players[userId]) this.players[userId] = createPlayer(userId);
      const player = this.migratePlayer(this.players[userId]);
      const previousFloor = player.checkpointFloor;
      player.checkpointFloor = Math.max(player.checkpointFloor, normalizedFloor);
      results.push({
        userId,
        previousFloor,
        checkpointFloor: player.checkpointFloor,
        updated: player.checkpointFloor > previousFloor,
      });
    }
    await this.save();
    return results;
  }

  async recordMaxReachedFloor(userIds, floor) {
    await this.ready;
    const normalizedFloor = Math.max(1, Math.floor(floor));

    for (const userId of userIds) {
      if (!this.players[userId]) this.players[userId] = createPlayer(userId);
      const player = this.migratePlayer(this.players[userId]);
      player.maxReachedFloor = Math.max(player.maxReachedFloor, normalizedFloor);
    }

    await this.save();
  }

  async resetAllPlayers() {
    await this.ready;
    const userIds = Object.keys(this.players);
    this.players = Object.fromEntries(
      userIds.map((userId) => [userId, createPlayer(userId)]),
    );
    await this.save();
    return { resetCount: userIds.length };
  }

  async save() {
    this.saveQueue = this.saveQueue.then(() =>
      writeFile(playersFile, `${JSON.stringify(this.players, null, 2)}\n`, 'utf8'),
    );

    return this.saveQueue;
  }
}

export const playerStore = new PlayerStore();
