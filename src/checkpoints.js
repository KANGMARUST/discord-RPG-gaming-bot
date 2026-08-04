export const FIRST_CHECKPOINT_FLOOR = 1;
export const CHECKPOINT_INTERVAL = 5;
export const MAX_DUNGEON_FLOOR = 100;

export function getUnlockedCheckpointFloors(highestCheckpointFloor = FIRST_CHECKPOINT_FLOOR) {
  const highest = Math.min(
    MAX_DUNGEON_FLOOR,
    Math.max(FIRST_CHECKPOINT_FLOOR, Math.floor(Number(highestCheckpointFloor) || 1)),
  );
  const floors = [FIRST_CHECKPOINT_FLOOR];
  for (let floor = 6; floor <= highest; floor += CHECKPOINT_INTERVAL) floors.push(floor);
  return floors;
}

export function getCheckpointFloorAfterBoss(bossFloor) {
  const floor = Math.floor(Number(bossFloor) || 0) + 1;
  return floor >= 6 && floor <= MAX_DUNGEON_FLOOR && (floor - 1) % CHECKPOINT_INTERVAL === 0
    ? floor
    : null;
}
