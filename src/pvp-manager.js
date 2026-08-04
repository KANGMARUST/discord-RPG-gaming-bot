import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { calculateTotalStats } from './equipment.js';
import { calculateSkillAttackPower, calculateSkillHealing, getSkill } from './skills.js';

const PVP_CATEGORY_NAME = 'PVP';
const PLAZA_CATEGORY_NAME = '탑';
const PLAZA_CHANNEL_NAME = '광장';
const TURN_SEPARATOR = '# ============================================================';
const RESOURCE_BAR_SEGMENTS = 10;
const waitAfterAction = () => new Promise((resolve) => setTimeout(resolve, 1_000));
const roundHealth = (value) => Math.round(value * 10) / 10;
const roundMana = (value) => Math.round(value * 10) / 10;

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
      values[userId] += 10_000 / Math.max(1, session.battle.stats[userId].speed);
    }
    return result;
  }

  async renderBattle(guild, session) {
    const channel = guild.channels.cache.get(session.textChannelId);
    const battle = session.battle;
    const [first, second] = session.memberIds;
    const playerStatus = session.memberIds.map((userId) => {
      const stats = battle.stats[userId];
      return [
        `<@${userId}> · Lv.${stats.playerLevel}`,
        `❤️ 체력 ${this.createResourceBar(battle.health[userId], stats.health)} ${battle.health[userId]}/${stats.health}`,
        `🔷 마나 ${this.createResourceBar(battle.mana[userId], stats.mana, '🟦')} ${battle.mana[userId]}/${stats.mana}`,
        `⚔️ 공격력 ${stats.attack}\t✨ 마법 공격력 ${stats.magicAttack}`,
        `🎯 치명타 확률 ${stats.criticalChance}%\t💥 치명타 피해 ${stats.criticalDamage}%`,
      ].join('\n');
    }).join('\n');
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
    battle.turnUserId = next;
    battle.actionValue[next] += 10_000 / Math.max(1, battle.stats[next].speed);
    battle.token = randomUUID().slice(0, 8);
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
      actionValue: Object.fromEntries(session.memberIds.map((id) => [id, 0])),
      turnUserId: null,
      token: null,
      message: null,
      actionCount: 0,
    };
    await this.nextTurn(guild, session);
    return { ok: true, session };
  }

  async handleButton(interaction) {
    const [, action, sessionId, token, skillId] = interaction.customId.split(':');
    const session = this.sessions.get(sessionId);
    if (!session?.battle || token !== session.battle.token) return interaction.reply({ content: '이미 처리된 결투 행동입니다.', flags: MessageFlags.Ephemeral });
    if (interaction.user.id !== session.battle.turnUserId) return interaction.reply({ content: '현재 턴인 플레이어만 행동할 수 있습니다.', flags: MessageFlags.Ephemeral });
    const actorId = interaction.user.id;
    const channel = interaction.guild.channels.cache.get(session.textChannelId);

    if (action === 'skill') {
      const skills = session.battle.equippedSkills[actorId].map(getSkill).filter(Boolean);
      if (skills.length === 0) return interaction.reply({ content: '장착한 스킬이 없습니다.', flags: MessageFlags.Ephemeral });
      return interaction.reply({
        content: '이번 턴에 시전할 스킬을 선택하세요.',
        components: [new ActionRowBuilder().addComponents(skills.map((skill) =>
          new ButtonBuilder()
            .setCustomId(`pvp:skill_select:${session.id}:${token}:${skill.id}`)
            .setLabel(`${skill.name} · 마나 ${skill.manaCost}`)
            .setStyle(skill.type === 'ATTACK' ? ButtonStyle.Danger : ButtonStyle.Success),
        ))],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (action === 'skill_select') {
      const skill = getSkill(skillId);
      if (!skill || !session.battle.equippedSkills[actorId].includes(skillId)) return interaction.reply({ content: '장착하지 않은 스킬입니다.', flags: MessageFlags.Ephemeral });
      if (session.battle.mana[actorId] < skill.manaCost) return interaction.reply({ content: '스킬 시전에 필요한 마나가 부족합니다.', flags: MessageFlags.Ephemeral });
      const actorStats = session.battle.stats[actorId];

      if (skill.type === 'HEAL') {
        if (session.battle.health[actorId] >= actorStats.health) return interaction.reply({ content: '체력이 이미 최대입니다.', flags: MessageFlags.Ephemeral });
        const before = session.battle.health[actorId];
        const healing = calculateSkillHealing(skill, actorStats.magicAttack);
        session.battle.health[actorId] = roundHealth(
          Math.min(actorStats.health, before + healing),
        );
        session.battle.mana[actorId] = roundMana(session.battle.mana[actorId] - skill.manaCost);
        session.battle.token = null;
        await interaction.update({ content: `${skill.name} 시전을 완료했습니다.`, components: [] });
        await session.battle.message.edit({ content: [TURN_SEPARATOR, `## 🟢 <@${actorId}>님의 턴`, `### ✨ 「${skill.name}」 시전`, `# 💚 ${roundHealth(session.battle.health[actorId] - before)} 회복`, `남은 마나: **${session.battle.mana[actorId]}**`, TURN_SEPARATOR].join('\n'), components: [] });
        await waitAfterAction();
        session.battle.actionCount += 1;
        await this.nextTurn(interaction.guild, session);
        return;
      }

      if (skill.type !== 'ATTACK') return interaction.reply({ content: '아직 사용할 수 없는 스킬 유형입니다.', flags: MessageFlags.Ephemeral });
      const defenderId = session.memberIds.find((id) => id !== actorId);
      const defender = session.battle.stats[defenderId];
      const attackPower = calculateSkillAttackPower(skill, actorStats.magicAttack);
      const levelDefenseBase = 200 + 10 * Math.max(1, actorStats.playerLevel);
      const defenseMultiplier = levelDefenseBase / (Math.max(0, defender.defense) + levelDefenseBase);
      const critical = Math.random() * 100 < actorStats.criticalChance;
      const variance = 0.9 + Math.random() * 0.2;
      const damage = Math.max(1, Math.round(attackPower * defenseMultiplier * variance * (critical ? actorStats.criticalDamage / 100 : 1)));
      session.battle.health[defenderId] = roundHealth(
        Math.max(0, session.battle.health[defenderId] - damage),
      );
      session.battle.mana[actorId] = roundMana(session.battle.mana[actorId] - skill.manaCost);
      session.battle.token = null;
      await interaction.update({ content: `${skill.name} 시전을 완료했습니다.`, components: [] });
      await session.battle.message.edit({ content: [TURN_SEPARATOR, `## 🟢 <@${actorId}>님의 턴`, `### ✨ 「${skill.name}」 시전`, `# 💥 ${damage} 마법 피해${critical ? ' · 치명타!' : ''}`, `<@${defenderId}>의 남은 체력: **${session.battle.health[defenderId]}/${defender.health}**`, `남은 마나: **${session.battle.mana[actorId]}**`, TURN_SEPARATOR].join('\n'), components: [] });
      await waitAfterAction();
      if (session.battle.health[defenderId] === 0) { await channel.send(`# 🏆 결투 종료\n<@${actorId}>님의 승리!`); setTimeout(() => this.end(interaction.client, session.id, '결투 종료').catch(() => {}), 10_000); return; }
      session.battle.actionCount += 1;
      await this.nextTurn(interaction.guild, session);
      return;
    }

    if (action !== 'attack') return interaction.reply({ content: '결투에서는 아이템을 사용할 수 없습니다.', flags: MessageFlags.Ephemeral });
    await interaction.deferUpdate();
    const defenderId = session.memberIds.find((id) => id !== actorId);
    const attacker = session.battle.stats[actorId]; const defender = session.battle.stats[defenderId];
    const levelDefenseBase = 200 + 10 * Math.max(1, attacker.playerLevel);
    const defenseMultiplier = levelDefenseBase / (Math.max(0, defender.defense) + levelDefenseBase);
    const critical = Math.random() * 100 < attacker.criticalChance;
    const variance = 0.9 + Math.random() * 0.2;
    const damage = Math.max(1, Math.round(attacker.attack * defenseMultiplier * variance * (critical ? attacker.criticalDamage / 100 : 1)));
    session.battle.health[defenderId] = roundHealth(
      Math.max(0, session.battle.health[defenderId] - damage),
    );
    session.battle.token = null;
    await session.battle.message.edit({ content: [TURN_SEPARATOR, `## 🟢 <@${actorId}>님의 턴`, '### 🗡️ 「일반 공격」 시전', `# 💥 ${damage} 피해${critical ? ' · 치명타!' : ''}`, `<@${defenderId}>의 남은 체력: **${session.battle.health[defenderId]}/${defender.health}**`, TURN_SEPARATOR].join('\n'), components: [] });
    await waitAfterAction();
    if (session.battle.health[defenderId] === 0) { await channel.send(`# 🏆 결투 종료\n<@${actorId}>님의 승리!`); setTimeout(() => this.end(interaction.client, session.id, '결투 종료').catch(() => {}), 10_000); return; }
    session.battle.actionCount += 1;
    await this.nextTurn(interaction.guild, session);
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
