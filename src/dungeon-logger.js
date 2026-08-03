import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
export const dungeonLogDirectory = path.join(currentDirectory, '..', 'logs', 'dungeon');
const MAX_DUNGEON_LOGS = 10;

class DungeonLogger {
  constructor() {
    this.records = new Map();
    this.saveQueues = new Map();
  }

  createFileName(adventure) {
    const timestamp = (adventure.startedAt ?? new Date().toISOString()).replace(/[:.]/g, '-');
    return `dungeon-${timestamp}-${adventure.id}.json`;
  }

  async start(adventure, players) {
    const record = {
      logVersion: 1,
      adventureId: adventure.id,
      guildId: adventure.guildId,
      leaderId: adventure.leaderId,
      memberIds: [...adventure.memberIds],
      startedAt: adventure.startedAt ?? new Date().toISOString(),
      endedAt: null,
      endReason: null,
      highestFloor: adventure.floor,
      players,
      events: [],
    };
    this.records.set(adventure.id, {
      fileName: this.createFileName(adventure),
      record,
    });
    await this.append(adventure.id, 'ADVENTURE_STARTED', {
      floor: adventure.floor,
      partySize: adventure.memberIds.length,
    });
  }

  async append(adventureId, type, data = {}) {
    const entry = this.records.get(adventureId);
    if (!entry) return false;
    entry.record.events.push({
      sequence: entry.record.events.length + 1,
      timestamp: new Date().toISOString(),
      type,
      ...data,
    });
    if (Number.isFinite(data.floor)) {
      entry.record.highestFloor = Math.max(entry.record.highestFloor, data.floor);
    }
    await this.save(adventureId);
    return true;
  }

  async finish(adventureId, reason, data = {}) {
    const entry = this.records.get(adventureId);
    if (!entry) return false;
    entry.record.endedAt = new Date().toISOString();
    entry.record.endReason = reason;
    entry.record.events.push({
      sequence: entry.record.events.length + 1,
      timestamp: entry.record.endedAt,
      type: 'ADVENTURE_ENDED',
      reason,
      ...data,
    });
    await this.save(adventureId);
    this.records.delete(adventureId);
    this.saveQueues.delete(adventureId);
    return true;
  }

  async save(adventureId) {
    const entry = this.records.get(adventureId);
    if (!entry) return;
    const previous = this.saveQueues.get(adventureId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        await mkdir(dungeonLogDirectory, { recursive: true });
        await writeFile(
          path.join(dungeonLogDirectory, entry.fileName),
          `${JSON.stringify(entry.record, null, 2)}\n`,
          'utf8',
        );
        await this.prune();
      })
      .catch((error) => console.error('던전 로그 저장에 실패했습니다.', error));
    this.saveQueues.set(adventureId, next);
    await next;
  }

  async prune() {
    const entries = (await readdir(dungeonLogDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.startsWith('dungeon-') && entry.name.endsWith('.json'));
    const files = await Promise.all(
      entries.map(async (entry) => ({
        name: entry.name,
        modifiedAt: (await stat(path.join(dungeonLogDirectory, entry.name))).mtimeMs,
      })),
    );
    files.sort((left, right) => right.modifiedAt - left.modifiedAt);
    await Promise.all(
      files.slice(MAX_DUNGEON_LOGS).map((file) =>
        unlink(path.join(dungeonLogDirectory, file.name)).catch(() => {}),
      ),
    );
  }
}

export const dungeonLogger = new DungeonLogger();
