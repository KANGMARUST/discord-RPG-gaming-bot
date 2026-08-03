export const LEVEL_STAT_GROWTH = {
  health: 8,
  mana: 8,
  defense: 2,
  attack: 3,
  magicAttack: 3,
  speed: 1,
};

export function getRequiredExperience(level) {
  const normalizedLevel = Math.max(1, level);
  const previousLevels = normalizedLevel - 1;
  return Math.round(100 + previousLevels * 50 + previousLevels ** 2 * 10);
}

export function getMonsterExperience(monsterLevel, playerLevel) {
  const normalizedMonsterLevel = Math.max(1, monsterLevel);
  const normalizedPlayerLevel = Math.max(1, playerLevel);
  const baseExperience = 45 + normalizedMonsterLevel * 15;
  const levelDifference = normalizedMonsterLevel - normalizedPlayerLevel;
  const levelMultiplier = Math.min(2.5, Math.max(0.5, 1 + levelDifference * 0.2));
  return Math.round(baseExperience * levelMultiplier);
}

export function grantExperienceToPlayer(player, monsterLevel, rewardMultiplier = 1) {
  const oldLevel = player.stats.playerLevel;
  const gainedExperience = Math.round(
    getMonsterExperience(monsterLevel, oldLevel) * Math.max(0, rewardMultiplier),
  );
  player.experience = (player.experience ?? 0) + gainedExperience;

  while (player.experience >= getRequiredExperience(player.stats.playerLevel)) {
    player.experience -= getRequiredExperience(player.stats.playerLevel);
    player.stats.playerLevel += 1;
    for (const [stat, growth] of Object.entries(LEVEL_STAT_GROWTH)) {
      player.stats[stat] += growth;
    }
  }

  return {
    gainedExperience,
    oldLevel,
    newLevel: player.stats.playerLevel,
    levelsGained: player.stats.playerLevel - oldLevel,
    experience: player.experience,
    requiredExperience: getRequiredExperience(player.stats.playerLevel),
  };
}
