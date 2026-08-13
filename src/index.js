import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import {
  calculateTotalStats,
  createEquipment,
  enhanceEquipment,
  equipmentSlots,
  formatEquipmentDetails,
  formatEquipmentName,
  getMaxEnhancement,
  getEquipmentName,
} from './equipment.js';
import { playerStore } from './player-store.js';
import { adventureManager, ENTRANCE_CHANNEL_NAME } from './adventure-manager.js';
import { AdventureSystem } from './adventure-system.js';
import { pvpManager } from './pvp-manager.js';
import { getPotionDescription, potionCatalog } from './items.js';
import { getRequiredExperience } from './leveling.js';
import {
  describeSkillEffect,
  formatSkill,
  getRecommendedStats,
  getSkill,
  getSkillCostText,
  skillCatalog,
  skillRarities,
} from './skills.js';
import { getUnlockedCheckpointFloors } from './checkpoints.js';
import { DUNGEON_REGIONS, createMonsterSkillSet } from './monster-catalog.js';

if (!process.env.DISCORD_TOKEN) {
  console.error('.env 파일에 DISCORD_TOKEN을 입력해 주세요.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
const BOT_DISPLAY_NAME = '라파엘(Rafael)';
const adventureSystem = new AdventureSystem(client, adventureManager, playerStore);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const enhancementImagePath = path.join(currentDirectory, '..', 'assets', 'ui', 'equipment-enhancement.png');
const skillCraftingImagePath = path.join(currentDirectory, '..', 'assets', 'ui', 'skill-crafting-altar.png');
const monsterAssetsDirectory = path.join(currentDirectory, '..', 'assets', 'monsters');

const choices = {
  rock: { label: '바위', emoji: '✊', beats: 'scissors' },
  paper: { label: '보', emoji: '✋', beats: 'rock' },
  scissors: { label: '가위', emoji: '✌️', beats: 'paper' },
};

const INVITATION_DURATION_MS = 30_000;
const STOP_VOTE_DURATION_MS = 30_000;
const DUEL_INVITATION_DURATION_MS = 30_000;
const ADVENTURE_PENALTY_WARNING_MS = 3_000;
const pendingDuels = new Map();
const debugGiveOptions = [
  { name: '[재화] 골드', value: 'currency:gold' },
  { name: '[재료] 마석', value: 'material:magic_stone' },
  ...Object.values(potionCatalog).map((potion) => ({
    name: `[포션] [${potion.rarity}] ${potion.name}`,
    value: `potion:${potion.id}`,
  })),
  ...Object.values(skillCatalog).map((skill) => ({
    name: `[스킬] [${skill.rarity}] ${skill.name}`,
    value: `skill:${skill.id}`,
  })),
  ...['일반', '고급', '레어', '전설'].flatMap((rarity) =>
    equipmentSlots.map((slot) => ({
      name: `[장비] [${rarity}] ${getEquipmentName(rarity, slot)}`,
      value: `equipment:${rarity}:${slot}`,
    })),
  ),
];

function hasPendingDuel(userId) {
  return [...pendingDuels.values()].some(
    (duel) => duel.challengerId === userId || duel.opponentId === userId,
  );
}
const pendingInvitations = new Map();
const pendingInvitationByUser = new Map();
const stopVotes = new Map();

async function startAdventureAfterPenaltyWarning(adventure) {
  const channel = await client.channels.fetch(adventure.textChannelId).catch(() => null);
  await channel?.send([
    '# ⚠️ 모험 페널티 안내',
    '던전에서 **사망**하거나 `/모험중지` 없이 음성 채널을 나가면,',
    '**이번 모험에서 획득한 장비와 골드가 모두 사라집니다.**',
    '장착 중인 장비와 모험 시작 전부터 보유한 골드는 사라지지 않습니다.',
    '',
    '3초 후 모험을 시작합니다...',
  ].join('\n'));
  await new Promise((resolve) => setTimeout(resolve, ADVENTURE_PENALTY_WARNING_MS));
  if (!adventureManager.adventures.has(adventure.id)) return false;
  await adventureSystem.start(adventure);
  return true;
}

adventureManager.setLeavePenaltyHandler((adventure, userId) =>
  adventureSystem.removeAdventureDeathRewards(adventure, userId));

function canStopDuringBattle(battle) {
  return !battle.partyHasTakenDamage || !battle.partyHasAttacked;
}

function createChoiceButtons(prefix, id, yesLabel, noLabel) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:${id}:yes`)
      .setLabel(yesLabel)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${prefix}:${id}:no`)
      .setLabel(noLabel)
      .setStyle(ButtonStyle.Danger),
  );
}

function invitationText(invitation) {
  const waitingCount =
    invitation.invitedIds.length - invitation.acceptedIds.size - invitation.declinedIds.size;
  return [
    `## ⚔️ <@${invitation.leaderId}>님의 던전 공대 모집`,
    invitation.invitedIds.map((id) => `<@${id}>`).join(' '),
    '**모험에 동행하시겠습니까?**',
    `동행 ${invitation.acceptedIds.size}명 · 거절 ${invitation.declinedIds.size}명 · 대기 ${waitingCount}명`,
    '30초 안에 선택해 주세요. 명령어를 입력한 사람은 공대장이 됩니다.',
  ].join('\n');
}

async function finishInvitation(invitationId) {
  const invitation = pendingInvitations.get(invitationId);
  if (!invitation || invitation.closing) return;
  invitation.closing = true;
  clearTimeout(invitation.timeout);
  pendingInvitations.delete(invitationId);
  for (const userId of invitation.invitedIds) pendingInvitationByUser.delete(userId);

  const guild = client.guilds.cache.get(invitation.guildId);
  if (!guild) return;

  const acceptedMembers = (
    await Promise.all(
      [...invitation.acceptedIds].map((id) => guild.members.fetch(id).catch(() => null)),
    )
  ).filter(
    (member) =>
      member &&
      !member.user.bot &&
      member.voice.channelId === invitation.entranceChannelId &&
      !adventureManager.getByUser(member.id),
  );
  const leader = acceptedMembers.find((member) => member.id === invitation.leaderId);

  if (!leader) {
    await invitation.message
      .edit({ content: '❌ 공대장이 던전입장 채널을 떠나 모집이 취소됐습니다.', components: [] })
      .catch(() => {});
    return;
  }

  const maxHealthByUser = {};
  for (const member of acceptedMembers) {
    const player = await playerStore.getOrCreate(member.id);
    maxHealthByUser[member.id] = calculateTotalStats(player).health;
  }

  try {
    const result = await adventureManager.startParty(guild, leader, acceptedMembers, maxHealthByUser);
    if (!result.ok) {
      const reason = result.reason === 'BOT_MISSING_PERMISSIONS'
        ? '봇에게 채널 관리와 멤버 이동 권한이 없습니다.'
        : '파티원 중 이미 모험 중인 사람이 있어 시작할 수 없습니다.';
      await invitation.message.edit({ content: `❌ ${reason}`, components: [] }).catch(() => {});
      return;
    }

    await startAdventureAfterPenaltyWarning(result.adventure);

    await invitation.message
      .edit({
        content: `✅ 공대 모집 완료! ${acceptedMembers.map((member) => `<@${member.id}>`).join(' ')}님이 1층으로 이동했습니다.`,
        components: [],
      })
      .catch(() => {});
  } catch (error) {
    console.error('파티 모험 시작 중 오류가 발생했습니다.', error);
    await invitation.message
      .edit({ content: '❌ 파티 채널 생성 또는 이동에 실패했습니다. 봇 권한을 확인해 주세요.', components: [] })
      .catch(() => {});
  }
}

function stopVoteText(vote) {
  const threshold = Math.floor(vote.memberIds.length / 2) + 1;
  return [
    '## 🛑 모험 중지 투표',
    `<@${vote.startedBy}>님이 모험 중지를 요청했습니다.`,
    `찬성 **${vote.yesIds.size}/${threshold}표** · 반대 **${vote.noIds.size}표**`,
    '파티의 과반수가 찬성하면 모험이 종료됩니다. 30초 안에 투표해 주세요.',
  ].join('\n');
}

async function closeStopVote(vote, content) {
  clearTimeout(vote.timeout);
  stopVotes.delete(vote.adventureId);
  await vote.message?.edit({ content, components: [] }).catch(() => {});
}

function createGameButtons() {
  return new ActionRowBuilder().addComponents(
    Object.entries(choices).map(([value, choice]) =>
      new ButtonBuilder()
        .setCustomId(`rps:${value}`)
        .setLabel(choice.label)
        .setEmoji(choice.emoji)
        .setStyle(ButtonStyle.Primary),
    ),
  );
}

function formatEquipmentItem(item) {
  if (!item) return '비어 있음';
  return formatEquipmentDetails(item);
}

function createPlayerEmbed(user, player) {
  const { equipment } = player;
  const stats = calculateTotalStats(player);

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`⚔️ ${user.displayName}님의 던전 캐릭터`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      {
        name: '📊 스탯',
        value: [
          `플레이어 레벨: **${stats.playerLevel}**`,
          `경험치: **${player.experience}/${getRequiredExperience(stats.playerLevel)}**`,
          `체력: **${stats.health}**`,
          `방어력: **${stats.defense}**`,
          `공격력: **${stats.attack}**`,
          `마법 공격력: **${stats.magicAttack}**`,
          `마나: **${stats.mana}**`,
          `속도: **${stats.speed}**`,
          `치명타 확률: **${stats.criticalChance}%**`,
          `치명타 피해: **${stats.criticalDamage}%**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '🎒 장비창',
        value: equipmentSlots
          .map((slot) => `**[${slot}]**\n${formatEquipmentItem(equipment[slot])}`)
          .join('\n\n'),
        inline: false,
      },
      {
        name: '🗼 탑 기록',
        value: [
          `최대 도달 층: **${player.maxReachedFloor ?? player.checkpointFloor ?? 1}층**`,
          `최고 체크포인트: **${player.checkpointFloor ?? 1}층**`,
          `시작 가능 층: **${getUnlockedCheckpointFloors(player.checkpointFloor).map((floor) => `${floor}층`).join(', ')}**`,
        ].join('\n'),
        inline: true,
      },
    )
    .setFooter({ text: '장비를 획득하면 각 슬롯에 장착할 수 있습니다.' });
}

function createDicoBotEasterEggEmbed(user) {
  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('✨ 디코봇 · 천상의 관리자')
    .setDescription('```신의 영역에 도달한 정체불명의 던전 관리자입니다.```')
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      {
        name: '📊 신성 스탯',
        value: [
          '플레이어 레벨: **Lv.1000**',
          '경험치: **측정 불가**',
          '체력: **99,999**',
          '방어력: **9,999**',
          '공격력: **12,345**',
          '마법 공격력: **12,345**',
          '마나: **99,999**',
          '속도: **777**',
          '치명타 확률: **100%**',
          '치명타 피해: **999%**',
        ].join('\n'),
        inline: true,
      },
      {
        name: '👑 착용 장비 · 신화',
        value: [
          '**[머리]** 라파엘의 성광 왕관 ★★★★★★★★★★\n└ 마나 +30,000 · 치명타 확률 +100%',
          '**[상의]** 종말을 거스르는 성갑 ★★★★★★★★★★\n└ 방어력 +9,000 · 체력 +50,000',
          '**[하의]** 천공의 심판 각반 ★★★★★★★★★★\n└ 체력 +49,000 · 속도 +300',
          '**[신발]** 공간을 가르는 성화 ★★★★★★★★★★\n└ 속도 +467 · 방어력 +4,000',
          '**[무기]** 창세의 성검 아우렐리아 ★★★★★★★★★★\n└ 공격력 +12,000 · 마법 공격력 +12,000',
        ].join('\n\n'),
        inline: false,
      },
      {
        name: '🗼 탑 기록',
        value: '최대 도달 층: **???층**\n최고 체크포인트: **신의 영역**',
        inline: true,
      },
    )
    .setFooter({ text: '이스터에그 발견! 이 장비는 플레이어가 획득할 수 없습니다.' });
}

function isDicoBotEasterEggTarget(interaction, target) {
  if (target.id === client.user?.id) return true;
  if (!target.bot) return false;
  const member = interaction.options.getMember('플레이어');
  const names = [target.username, target.globalName, member?.displayName]
    .filter(Boolean)
    .map((name) => name.replaceAll(' ', '').toLocaleLowerCase('ko-KR'));
  return names.includes('디코봇');
}

const monsterCatalogEntries = [
  ...DUNGEON_REGIONS.flatMap((region) => [
    {
      id: `normal:${region.id}`,
      name: region.normal.name,
      type: 'NORMAL',
      region,
      minFloor: region.minFloor,
      maxFloor: region.maxFloor,
      image: region.normal.image,
    },
    {
      id: `boss:${region.id}`,
      name: region.boss.name,
      type: 'BOSS',
      region,
      minFloor: region.maxFloor,
      maxFloor: region.maxFloor,
      image: region.boss.image,
    },
  ]),
  {
    id: 'mimic',
    name: '미믹',
    type: 'MIMIC',
    region: DUNGEON_REGIONS[0],
    minFloor: 1,
    maxFloor: 100,
    image: 'mimic.png',
  },
];

function calculateCatalogMonsterStats(level, type) {
  const isBoss = type === 'BOSS';
  const isMimic = type === 'MIMIC';
  const healthMultiplier = isBoss ? 1.8 : isMimic ? 1.25 : 1;
  const combatMultiplier = isBoss || isMimic ? 1.25 : 1;
  return {
    health: Math.round((30 + level * 15) * healthMultiplier),
    attack: Math.round((12 + level * 4) * combatMultiplier),
    defense: Math.round((2 + level * 1.2) * combatMultiplier),
    magicDefense: Math.round((1 + level * 1.2) * combatMultiplier),
    speed: Math.round((7 + level) * combatMultiplier),
  };
}

function formatCatalogStatRange(entry, statKey) {
  const first = calculateCatalogMonsterStats(entry.minFloor, entry.type)[statKey];
  const last = calculateCatalogMonsterStats(entry.maxFloor, entry.type)[statKey];
  return first === last ? String(first) : `${first} ~ ${last}`;
}

function getCatalogMonsterSkills(entry) {
  return createMonsterSkillSet(entry.region, {
    isBoss: entry.type === 'BOSS',
    isMimic: entry.type === 'MIMIC',
  });
}

function formatCatalogMonsterSkill(skill, totalWeight) {
  const typeText = {
    SINGLE_ATTACK: '단일 공격',
    PARTY_ATTACK: '파티 전체 공격',
    SELF_HEAL: '자신 회복',
    DRAIN_ATTACK: '흡혈 공격',
  }[skill.type] ?? '특수 기술';
  const details = [typeText];
  if (skill.powerCoefficient) details.push(`공격력 × ${skill.powerCoefficient}`);
  if (skill.criticalChanceBonus) details.push(`치명타 확률 +${skill.criticalChanceBonus}%`);
  if (skill.maxHealthCoefficient) details.push(`최대 체력의 ${Math.round(skill.maxHealthCoefficient * 100)}% 회복`);
  if (skill.lifeStealRatio) details.push(`실제 피해의 ${Math.round(skill.lifeStealRatio * 100)}% 흡혈`);
  if (skill.statusEffect?.type === 'SLOW') {
    details.push(`둔화 ${skill.statusEffect.speedReductionPercent}% · ${skill.statusEffect.duration}턴`);
  }
  if (skill.statusEffect?.type === 'DOT') {
    details.push(`${skill.statusEffect.name} · ${skill.statusEffect.duration}턴 지속 피해`);
  }
  const chance = Math.round(((skill.weight ?? 1) / totalWeight) * 100);
  return `**${skill.name}**\n└ ${details.join(' · ')} · 선택 ${chance}%`;
}

function createMonsterCatalogListEmbed() {
  const lines = DUNGEON_REGIONS.map((region) =>
    `**${region.minFloor}~${region.maxFloor}층 · ${region.regionName}**\n${region.normal.name} · ${region.boss.name} (${region.maxFloor}층 보스)`,
  );
  lines.push('**특수 사건 · 1~100층**\n미믹 (보물상자에서 출현 가능)');
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📚 던전 적도감')
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: '/적도감 적이름으로 체력·스탯·시전 스킬을 자세히 확인할 수 있습니다.' });
}

function createMonsterCatalogDetailPayload(entry) {
  const skills = getCatalogMonsterSkills(entry);
  const totalWeight = skills.reduce((total, skill) => total + (skill.weight ?? 1), 0);
  const floorText = entry.type === 'MIMIC'
    ? '특수 사건 · 1~100층'
    : entry.type === 'BOSS'
      ? `${entry.minFloor}층 보스`
      : `${entry.minFloor}~${entry.maxFloor}층`;
  const attachmentName = `catalog-${entry.id.replace(':', '-')}.png`;
  const attachment = new AttachmentBuilder(path.join(monsterAssetsDirectory, entry.image), {
    name: attachmentName,
  });
  const typeLabel = entry.type === 'BOSS' ? '👑 보스' : entry.type === 'MIMIC' ? '🎁 특수 적' : '👾 일반 적';
  const embed = new EmbedBuilder()
    .setColor(entry.type === 'BOSS' ? 0x9b111e : entry.type === 'MIMIC' ? 0xf1c40f : 0xe67e22)
    .setTitle(`${typeLabel} · ${entry.name}`)
    .setDescription(`서식: **${floorText}**${entry.type === 'MIMIC' ? '' : ` · ${entry.region.regionName}`}`)
    .setImage(`attachment://${attachmentName}`)
    .addFields(
      {
        name: '📊 기본 스탯 · 1인 파티 기준',
        value: [
          `레벨: **${entry.minFloor === entry.maxFloor ? entry.minFloor : `${entry.minFloor} ~ ${entry.maxFloor}`}**`,
          `체력: **${formatCatalogStatRange(entry, 'health')}**`,
          `공격력: **${formatCatalogStatRange(entry, 'attack')}**`,
          `방어력: **${formatCatalogStatRange(entry, 'defense')}**`,
          `마법 방어력: **${formatCatalogStatRange(entry, 'magicDefense')}**`,
          `속도: **${formatCatalogStatRange(entry, 'speed')}**`,
          '치명타 확률: **5%** · 치명타 피해: **150%**',
        ].join('\n'),
        inline: true,
      },
      {
        name: `✨ 시전 스킬 (${skills.length}개)`,
        value: skills.map((skill) => formatCatalogMonsterSkill(skill, totalWeight)).join('\n\n'),
        inline: false,
      },
    )
    .setFooter({ text: '실제 전투에서는 파티 인원에 따라 적의 체력·공격력·방어력·속도가 추가로 상승합니다.' });
  return { embeds: [embed], files: [attachment] };
}

const rankingCategories = {
  레벨: { title: '🏆 레벨 랭킹', label: '레벨', getValue: (player) => calculateTotalStats(player).playerLevel },
  탑: { title: '🗼 탑 랭킹', label: '최대 도달 층', getValue: (player) => player.maxReachedFloor ?? player.checkpointFloor ?? 1, suffix: '층' },
  체력: { title: '❤️ 체력 랭킹', label: '체력', getValue: (player) => calculateTotalStats(player).health },
  방어력: { title: '🛡️ 방어력 랭킹', label: '방어력', getValue: (player) => calculateTotalStats(player).defense },
  공격력: { title: '⚔️ 공격력 랭킹', label: '공격력', getValue: (player) => calculateTotalStats(player).attack },
  마법공격력: { title: '✨ 마법 공격력 랭킹', label: '마법 공격력', getValue: (player) => calculateTotalStats(player).magicAttack },
  마나: { title: '🔷 마나 랭킹', label: '마나', getValue: (player) => calculateTotalStats(player).mana },
  속도: { title: '💨 속도 랭킹', label: '속도', getValue: (player) => calculateTotalStats(player).speed },
  치명타확률: { title: '🎯 치명타 확률 랭킹', label: '치명타 확률', getValue: (player) => calculateTotalStats(player).criticalChance, suffix: '%' },
  치명타피해: { title: '💥 치명타 피해 랭킹', label: '치명타 피해', getValue: (player) => calculateTotalStats(player).criticalDamage, suffix: '%' },
};

function formatRankingValue(value, suffix = '') {
  const roundedValue = Math.round(value * 10) / 10;
  return `${Number.isInteger(roundedValue) ? roundedValue : roundedValue.toFixed(1)}${suffix}`;
}

async function createRankingEmbed(categoryName) {
  const category = rankingCategories[categoryName];
  const rankedPlayers = (await playerStore.getAllPlayers())
    .map((player) => ({ player, value: category.getValue(player) }))
    .sort((left, right) => right.value - left.value || left.player.userId.localeCompare(right.player.userId))
    .slice(0, 10);

  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(category.title)
    .setDescription(
      rankedPlayers.length
        ? rankedPlayers
            .map(({ player, value }, index) => {
              const medal = ['🥇', '🥈', '🥉'][index] ?? `**${index + 1}.**`;
              return `${medal} <@${player.userId}> — **${formatRankingValue(value, category.suffix)} ${category.label}**`;
            })
            .join('\n')
        : '아직 랭킹에 등록된 플레이어가 없습니다.',
    )
    .setFooter({ text: '장착 중인 장비의 효과가 반영된 현재 스탯 기준입니다.' });
}

function createEquipmentInventoryEmbed(user, player) {
  const equippedList = equipmentSlots
    .map((slot) => `**[${slot}]** ${player.equipment[slot] ? formatEquipmentDetails(player.equipment[slot]) : '비어 있음'}`)
    .join('\n\n');
  const equipmentList = player.equipmentInventory.equipment.length
    ? player.equipmentInventory.equipment
        .map((item, index) => `**${index + 1}.** ${formatEquipmentDetails(item)}`)
        .join('\n\n')
    : '보유한 아이템이 없습니다.';
  const materialList = Object.entries(player.equipmentInventory.materials)
    .map(([name, quantity]) => `${name}: **${quantity.toLocaleString('ko-KR')}개**`)
    .join('\n');

  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`🛡️ ${user.displayName}님의 장비 인벤토리`)
    .setDescription(`## 📌 현재 착용 중\n${equippedList}\n\n## 🎒 장비 인벤토리\n${equipmentList}`.slice(0, 4096))
    .addFields(
      { name: '💎 강화 재료', value: materialList || '보유한 강화 재료가 없습니다.' },
      { name: '💰 보유 골드', value: `**${player.gold.toLocaleString('ko-KR')} 골드**` },
    )
    .setFooter({ text: '/장비장착, /장비강화, /장비분해 또는 /장비잠금 명령어를 사용할 수 있습니다.' });
}

function createItemInventoryEmbed(user, player) {
  const itemList = player.itemInventory.length
    ? player.itemInventory
        .map(
          (item, index) =>
            `**${index + 1}. ${item.name} × ${item.quantity ?? 1}**${item.description ? `\n${item.description}` : ''}`,
        )
        .join('\n\n')
    : '던전에서 사용할 수 있는 아이템이 없습니다.';

  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`🧪 ${user.displayName}님의 아이템 인벤토리`)
    .setDescription(itemList)
    .addFields({ name: '💰 보유 골드', value: `**${player.gold.toLocaleString('ko-KR')} 골드**` })
    .setFooter({ text: '이곳의 아이템은 던전 전투에서 사용할 수 있습니다.' });
}

function splitSkillLines(lines, maximumLength = 1_000) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length + 2 > maximumLength) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function formatSkillCatalogLine(skill, marker = '') {
  const roles = skill.roleTags?.join('·') ?? '범용';
  const recommendedStats = getRecommendedStats(skill).join('·') || '자유 선택';
  const soloRule = skill.roleTags?.includes('솔로')
    ? skill.requiresSolo
      ? ' · 혼자일 때만 사용'
      : ' · 파티 사용 시 효과 50%'
    : '';
  return `${marker} **[${skill.rarity}] ${skill.name}** · ${getSkillCostText(skill)}\n` +
    `└ ${describeSkillEffect(skill)}\n` +
    `└ 추천 역할: ${roles} · 추천 스탯: ${recommendedStats}${soloRule}`;
}

function createSkillInventoryEmbeds(user, player) {
  const equippedSkillFields = player.equippedSkills
    .map((skillId, index) => {
      const skill = skillId ? getSkill(skillId) : null;
      return {
        name: `스킬 ${index + 1}`,
        value: skill ? `**[${skill.rarity}] ${skill.name}**` : '*비어 있음*',
        inline: true,
      };
    });
  const skillFragmentText = skillRarities
    .map((rarity) => `**${rarity}**: ${player.skillFragments?.[rarity] ?? 0}개`)
    .join('\n');
  const embeds = [new EmbedBuilder()
    .setColor(0x8e44ad)
    .setTitle(`📖 ${user.displayName}님의 스킬북`)
    .addFields(
      ...equippedSkillFields,
      { name: '🧩 보유 스킬 조각', value: skillFragmentText, inline: true },
    )
    .setFooter({ text: '같은 등급 조각 10개는 /스킬제작 등급으로 해당 등급의 새 스킬을 제작할 수 있습니다.' })];
  const ownedSkills = player.skillInventory.map(getSkill).filter(Boolean);
  for (const rarity of skillRarities) {
    const lines = ownedSkills
      .filter((skill) => skill.rarity === rarity)
      .map((skill) => formatSkillCatalogLine(skill, '✅'));
    if (lines.length === 0) continue;
    const chunks = splitSkillLines(lines);
    embeds.push(new EmbedBuilder()
      .setColor(0x8e44ad)
      .setTitle(`📖 보유 ${rarity} 스킬 · ${lines.length}개`)
      .addFields(chunks.map((value, index) => ({
        name: chunks.length > 1 ? `${rarity} 스킬 ${index + 1}/${chunks.length}` : `${rarity} 스킬`,
        value,
      }))));
  }
  if (ownedSkills.length === 0) embeds[0].setDescription('보유한 스킬이 없습니다.');
  return embeds;
}

const skillCatalogRolePages = [
  { role: '탱커', emoji: '🛡️', summary: '도발·보호막·피해 경감으로 파티의 공격을 대신 견디는 역할입니다.', stats: '체력 · 방어력' },
  { role: '물리 딜러', emoji: '⚔️', summary: '공격력 기반 검술로 적을 빠르게 처치하는 역할입니다.', stats: '공격력 · 치명타 확률 · 치명타 피해' },
  { role: '마법 딜러', emoji: '✨', summary: '마법공격력과 마나를 사용해 강한 마법 피해를 주는 역할입니다.', stats: '마법공격력 · 마나 · 치명타 확률 · 치명타 피해' },
  { role: '힐러', emoji: '💚', summary: '회복과 정화로 파티의 생존을 돕는 역할입니다.', stats: '마법공격력 · 마나 · 속도' },
  { role: '버퍼', emoji: '⬆️', summary: '아군의 공격과 방어를 강화해 파티 전체의 전투력을 높이는 역할입니다.', stats: '마법공격력 · 마나 · 속도' },
  { role: '디버퍼', emoji: '⬇️', summary: '적의 능력치를 낮추고 행동을 방해하는 역할입니다.', stats: '마법공격력 · 마나 · 속도' },
  { role: '하이브리드 딜러', emoji: '⚜️', summary: '공격력과 마법공격력을 함께 활용하는 유연한 공격 역할입니다.', stats: '공격력 · 마법공격력 · 치명타 확률 · 치명타 피해' },
  { role: '솔로', emoji: '🐺', summary: '혼자 모험할 때 성능이 강해지는 생존형 역할입니다.', stats: '체력 · 방어력 · 공격력 또는 마법공격력' },
];

function normalizeCatalogPage(pageIndex) {
  const length = skillCatalogRolePages.length;
  const parsed = Number.parseInt(pageIndex, 10);
  return Number.isInteger(parsed) ? ((parsed % length) + length) % length : 0;
}

function createSkillCatalogPage(user, player, pageIndex = 0) {
  const rarityOrder = { 일반: 1, 고급: 2, 레어: 3, 전설: 4 };
  const page = normalizeCatalogPage(pageIndex);
  const rolePage = skillCatalogRolePages[page];
  const ownedIds = new Set(player.skillInventory);
  const skills = Object.values(skillCatalog)
    .filter((skill) => skill.roleTags?.includes(rolePage.role))
    .sort((left, right) =>
    rarityOrder[left.rarity] - rarityOrder[right.rarity] || left.name.localeCompare(right.name, 'ko-KR'));
  const ownedSkills = skills.filter((skill) => ownedIds.has(skill.id));
  const unownedSkills = skills.length - ownedSkills.length;
  const embed = new EmbedBuilder()
    .setColor(0x6c5ce7)
    .setTitle(`📚 ${user.displayName}님의 스킬도감 · ${rolePage.emoji} ${rolePage.role}`)
    .setDescription([
      rolePage.summary,
      `추천 스탯: **${rolePage.stats}**`,
      `이 역할 스킬 **${skills.length}개** · 보유 **${ownedSkills.length}개** · 미보유 **${unownedSkills}개**`,
      rolePage.role === '솔로' ? '솔로 스킬은 혼자일 때 100% 성능이며 파티에서는 50%로 감소합니다. `고독한 늑대`는 혼자일 때만 사용할 수 있습니다.' : '스킬 3개 조합을 통해 원하는 역할을 만들어 보세요.',
    ].join('\n'))
    .setFooter({ text: `${page + 1}/${skillCatalogRolePages.length} 페이지 · 이전/다음 버튼으로 역할을 바꿀 수 있습니다.` });
  if (skills.length === 0) {
    embed.addFields({ name: '스킬 목록', value: '이 역할에 등록된 스킬이 아직 없습니다.' });
  } else {
    for (const rarity of skillRarities) {
      const lines = skills
        .filter((skill) => skill.rarity === rarity)
        .map((skill) => formatSkillCatalogLine(skill, ownedIds.has(skill.id) ? '✅' : '🔒'));
      const chunks = splitSkillLines(lines);
      if (chunks.length === 0) {
        embed.addFields({ name: `${rarity} 스킬`, value: `이 역할의 ${rarity} 스킬은 아직 없습니다.` });
        continue;
      }
      embed.addFields(chunks.map((value, index) => ({
        name: chunks.length > 1 ? `${rarity} 스킬 ${index + 1}/${chunks.length}` : `${rarity} 스킬`,
        value,
      })));
    }
  }
  const previousPage = normalizeCatalogPage(page - 1);
  const nextPage = normalizeCatalogPage(page + 1);
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`skill_catalog:${user.id}:${previousPage}`)
      .setLabel('◀ 이전 역할')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`skill_catalog:${user.id}:${nextPage}`)
      .setLabel('다음 역할 ▶')
      .setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [controls] };
}

function createShopPayload(user, player) {
  const potions = Object.values(potionCatalog);
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🏪 포션 상점')
    .setDescription(
      potions
        .map(
          (potion) => {
            const owned = player.itemInventory.find((item) => item.id === potion.id)?.quantity ?? 0;
            const salePrice = Math.max(1, Math.floor(potion.price * 0.5));
            return `**${potion.name}** · 구매 ${potion.price.toLocaleString('ko-KR')}G · 판매 ${salePrice.toLocaleString('ko-KR')}G · 보유 ${owned}개\n${getPotionDescription(potion)}`;
          },
        )
        .join('\n\n'),
    )
    .addFields({
      name: '💰 현재 보유 골드',
      value: `**${player.gold.toLocaleString('ko-KR')} 골드**`,
    })
    .addFields({
      name: '💎 강화 재료 교환',
      value: '**마석 1개** · 500골드',
    })
    .setFooter({ text: '구매 또는 판매 버튼을 누르면 포션 1개를 거래합니다.' });
  const rows = [];
  for (let index = 0; index < potions.length; index += 4) {
    rows.push(
      new ActionRowBuilder().addComponents(
        potions.slice(index, index + 4).map((potion) =>
          new ButtonBuilder()
            .setCustomId(`shop:buy:${potion.id}:${user.id}`)
            .setLabel(`구매 · ${potion.name}`)
            .setStyle(potion.type === 'HEALTH' ? ButtonStyle.Danger : ButtonStyle.Primary),
        ),
      ),
    );
  }
  for (let index = 0; index < potions.length; index += 4) {
    rows.push(
      new ActionRowBuilder().addComponents(
        potions.slice(index, index + 4).map((potion) => {
          const owned = player.itemInventory.find((item) => item.id === potion.id)?.quantity ?? 0;
          return new ButtonBuilder()
            .setCustomId(`shop:sell:${potion.id}:${user.id}`)
            .setLabel(`판매 · ${potion.name}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(owned <= 0);
        }),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`shop:material:magic_stone:${user.id}`)
        .setLabel('마석 1개 교환 · 500G')
        .setEmoji('💎')
        .setStyle(ButtonStyle.Success),
    ),
  );
  return { embeds: [embed], components: rows, flags: MessageFlags.Ephemeral };
}

function createHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📖 ${BOT_DISPLAY_NAME} 도움말`)
    .setDescription('명령어는 `/`를 입력한 뒤 선택해서 사용할 수 있습니다.')
    .addFields(
      {
        name: '🧙 캐릭터',
        value: [
          '`/내정보` — 내 스탯과 현재 장착 장비 확인',
          '`/정보 플레이어` — 선택한 다른 플레이어의 스탯과 장착 장비 확인',
          '`/파티원스텟` — 모험 중인 전투 채널에서 현재 체력·마나를 포함한 파티 전체 스탯 확인',
        ].join('\n'),
      },
      {
        name: '🎒 인벤토리 및 장비',
        value: [
          '`/장비인벤토리` — 보유 장비, 마석, 골드 확인',
          '`/아이템인벤토리` — 보유 포션 등 소비 아이템 확인',
          '`/장비장착 아이템이름` — 플레이어 레벨 이하의 고유 레벨 장비 장착',
          '`/자동장착` — 내 레벨 이하 장비만 대상으로 고유 레벨 → 등급 순 자동 장착',
          '`/장비강화 아이템이름` — 마석을 사용하여 인벤토리 또는 장착 중인 장비 강화',
          '`/장비분해 장비` — 장비를 분해하여 등급·강화 단계에 따른 마석 획득',
          '`/장비일괄분해 고유레벨이하 등급이하` — 조건에 맞는 잠금 해제 장비 일괄 분해',
          '`/장비잠금 장비 상태` — 실수로 분해하지 않도록 장비 잠금 또는 해제',
        ].join('\n'),
      },
      {
        name: '✨ 스킬',
        value: [
          '`/스킬북` — 장착 슬롯 1~3과 현재 보유한 스킬 확인',
          '`/스킬도감` — 역할별 페이지에서 전체 스킬과 추천 스탯 확인',
          '`/스킬제작 등급` — 해당 등급의 스킬 조각 10개로 새로운 스킬 제작',
          '`/스킬장착 스킬 슬롯` — 보유 스킬을 지정한 1~3번 슬롯에 장착',
          '`/스킬장착해제 슬롯` — 지정 슬롯을 비움(스킬은 스킬북에 유지)',
          '`/도움말 아이템이름` — 선택한 스킬의 등급·마나·계수·효과 확인',
          '총 50종의 스킬 중 최대 3개를 조합하며, 선택한 스킬과 투자 스탯에 따라 탱커·딜러·힐러·버퍼 역할이 정해집니다.',
          '검술 등 무마나 스킬은 공격력 계수를 사용하고 재사용 대기시간이 있으며, 주문은 마법 공격력과 마나를 사용합니다.',
          '솔로 스킬은 혼자일 때 100%, 파티에서는 50% 성능입니다. `고독한 늑대`는 혼자일 때만 사용할 수 있습니다.',
          '모험 중에는 장착 상태를 변경할 수 없습니다.',
          '스킬 조각은 몬스터·보스·보물상자에서 획득하며, 수량은 `/스킬북`에서 확인합니다.',
        ].join('\n'),
      },
      {
        name: '🏪 상점',
        value: '`/상점` — 포션 구매·판매 또는 500골드로 마석 1개 교환',
      },
      {
        name: '⚔️ 던전',
        value: [
          '`/모험시작` — 던전입장 음성 채널에서 모험 또는 공대 모집 시작 (공대장이 해금된 체크포인트 선택)',
          '`/모험중지` — 전투 중에는 파티의 공격·피격이 모두 발생하기 전까지만 1인 종료/파티 중지 투표',
          '`/적도감 적이름` — 적의 서식 층수와 스탯·시전 스킬 확인',
          '전투에서는 자신의 턴에 일반 공격, 장착 스킬, 아이템 사용 버튼을 선택합니다.',
          '일반 몬스터와 미믹도 여러 기술을 사용하며, 보스는 단일·광역·치명타·상태이상·회복 기술을 사용합니다.',
          '망자·혈맹·공허·마계·신살자·종말 계열 적은 실제로 준 피해의 일부를 흡수해 체력을 회복합니다.',
          '전투 파티 상세에는 체력·마나 바, 다음 5턴 순서와 파티 스탯이 표시됩니다.',
          '관전자는 모험 채팅과 음성방을 볼 수 있지만 입장·채팅·명령·전투 조작은 할 수 없습니다.',
          '5층 단위 보스를 처치하면 다음 구간 체크포인트가 생존 파티원 전원에게 자동 저장됩니다.',
        ].join('\n'),
      },
      {
        name: '🏟️ PVP',
        value: [
          '`/결투신청 상대` — 같은 음성 채널의 플레이어에게 결투 신청',
          '`/항복` — 진행 중인 결투에서 항복하고 상대방의 승리로 종료',
          '결투 전투는 던전과 같은 턴·스킬 규칙을 사용하지만 아이템은 사용할 수 없습니다.',
        ].join('\n'),
      },
      {
        name: '🎮 기타',
        value: [
          '`/게임시작` — 가위바위보 미니게임 시작',
          '`/ping` — 봇 연결 상태와 지연 시간 확인',
          '`/가이드북` — 처음 시작하는 플레이어를 위한 단계별 안내',
          '`/도움말` — 현재 도움말 표시',
          '`/도움말 항목:확률` — 던전의 탐험·드랍·전투 확률 확인',
          '`/도움말 항목:버프` — 버프 정보 확인',
          '`/도움말 항목:디버프` — 디버프 정보 확인',
          '`/도움말 아이템이름` — 포션·보유 장비·스킬의 상세 정보 확인',
        ].join('\n'),
      },
    )
    .setFooter({ text: '이 도움말은 명령어를 실행한 사용자에게만 표시됩니다.' });
}

function createGuidebookEmbed() {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`📗 ${BOT_DISPLAY_NAME} 가이드북`)
    .setDescription('처음이라도 아래 순서대로 따라 하면 바로 모험을 시작할 수 있습니다. 모든 내용은 나에게만 보입니다.')
    .addFields(
      {
        name: '1️⃣ 캐릭터 확인',
        value: [
          '`/내정보`로 내 레벨, 체력, 공격력 등 기본 스탯을 확인하세요.',
          '`/장비인벤토리`에서 장비와 골드·마석을, `/아이템인벤토리`에서 포션을 확인할 수 있습니다.',
        ].join('\n'),
      },
      {
        name: '2️⃣ 장비와 스킬 준비',
        value: [
          '`/장비장착 아이템이름`으로 장비를 착용합니다. 장비 고유 레벨이 내 레벨보다 높으면 착용할 수 없습니다.',
          '`/자동장착`은 착용 가능한 장비 중 좋은 장비를 자동으로 골라 줍니다.',
          '`/스킬도감`에서 역할별 페이지로 전체 스킬을 보고, `/스킬북`에서 보유 스킬과 장착 상태를 확인하세요.',
          '`/스킬장착 스킬 슬롯`으로 최대 3개 스킬을 준비하세요.',
          '도감의 **추천 역할**과 **추천 스탯**을 참고하세요. 탱커는 방어력·체력, 물리 딜러는 공격력·치명타, 힐러·버퍼는 마법 공격력·마나가 핵심입니다.',
          '솔로 스킬은 혼자일 때 강하지만 파티에서는 효과가 절반이므로, 파티에서는 도발·광역힐·보호막·버프를 나눠 장착하는 편이 강합니다.',
        ].join('\n'),
      },
      {
        name: '3️⃣ 모험 시작',
        value: [
          '서버의 **던전입장** 음성 채널에 들어간 뒤 `/모험시작`을 사용하세요.',
          '혼자면 바로 시작하고, 함께 있는 사람이 있으면 동행 여부를 물어봅니다. 명령어를 입력한 사람이 공대장입니다.',
          '모험이 시작되면 전용 음성·채팅방으로 이동합니다. 공대장은 1층과 해금한 모든 체크포인트 중 시작 층을 선택할 수 있습니다.',
          '5층 단위 보스를 처치하면 다음 층 체크포인트가 현재 파티원 전원에게 자동 저장됩니다.',
        ].join('\n'),
      },
      {
        name: '4️⃣ 전투 방법',
        value: [
          '전투 채팅에서 **내 턴**일 때만 내 행동 버튼이 보입니다. 일반 공격, 스킬 시전, 아이템 사용 중 하나를 선택하세요.',
          '협동 전투에서는 마력 증폭·수호 결계로 원하는 파티원을 강화하고, 수호자의 도발로 적의 공격을 대신 받아낼 수 있습니다.',
          '파티원 스탯과 적 상태에서 버프·디버프의 남은 턴을 확인하세요.',
          '턴 순서는 속도에 따라 결정되며, 다음 5턴의 순서도 전투 메시지에서 확인할 수 있습니다.',
          '적의 둔화는 속도와 턴 순서를 낮추며, 저주·부식은 자신의 턴이 시작될 때 3턴 동안 지속 피해를 줍니다.',
          '체력이 0이 되거나 음성 채널을 나가면 모험이 끝납니다. 전투 중 얻은 미장착 장비는 사라질 수 있으니 주의하세요.',
        ].join('\n'),
      },
      {
        name: '5️⃣ 보상과 성장',
        value: [
          '몬스터 처치로 경험치·골드·장비·포션을 얻습니다. 높은 레벨 몬스터일수록 경험치를 더 많이 줍니다.',
          '장비는 `/장비강화`로 강화하고, 필요 없는 장비는 `/장비분해`하여 마석으로 바꿀 수 있습니다.',
          '`/상점`에서 골드로 포션을 사고팔거나 마석을 교환할 수 있습니다.',
        ].join('\n'),
      },
      {
        name: '💡 더 알아보기',
        value: '`/도움말`에서 전체 명령어를, `/도움말 항목:확률`에서 드랍·탐험 확률을 확인하세요.',
      },
    )
    .setFooter({ text: '막히면 /도움말 또는 /가이드북을 다시 확인해 보세요.' });
}

function createProbabilityHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🎲 던전 확률 정보')
    .setDescription('현재 게임에 적용 중인 확률입니다. 층수와 전투 횟수에 따라 바뀌는 항목은 계산식도 함께 표시합니다.')
    .addFields(
      {
        name: '🧭 일반 층 탐험',
        value: [
          '계단: **20% + 현재 층 처치 전투당 10%** (최대 65%)',
          '특수 이벤트: **20%**',
          '적 조우: 남은 확률 (처음 60% → 처치 1회당 10% 감소, 최소 15%)',
          '발견한 계단에서 “더 탐험”: 특수 이벤트 **30%** / 적 조우 **70%**',
        ].join('\n'),
      },
      {
        name: '👑 5층 단위 보스 층',
        value: [
          '보스를 아직 처치하지 않았을 때: 보스 조우 **30%** / 특수 이벤트 **20%** / 일반 적 **50%**',
          '보스를 처치하면 보물상자 **100%** 획득 후 다음 층으로 이동할 수 있습니다.',
        ].join('\n'),
      },
      {
        name: '✨ 특수 이벤트',
        value: [
          '특수 이벤트를 발견하면 신비한 문 앞에서 들어갈지 선택합니다.',
          '보물상자: **50%** · 함정: **30%** · 휴식: **20%**',
          '보물상자 발견 시: 일반 상자 **90%** / 미믹 전투 **10%**',
          '휴식은 잃은 체력의 50%를 회복합니다.',
        ].join('\n'),
      },
      {
        name: '🎁 장비·포션 드랍',
        value: [
          '장비: 일반 적·보스 **30%**, 미믹 **70%**, 보물상자 **100%**',
          '포션: 일반 적·보스·미믹 **30%**, 보물상자 **65%**',
          '포션 등급(드랍 성공 시): 일반 **55%** / 고급 **28%** / 레어 **12%** / 전설 **5%**',
          '포션 종류(등급 결정 후): 체력 **50%** / 마나 **50%**',
        ].join('\n'),
      },
      {
        name: '🧩 스킬 조각 드랍',
        value: [
          '일반 몬스터·미믹: **12%**',
          '보스: **100%**',
          '일반 보물상자: **30%**',
          '일반 적 등급: 일반 **55%** / 고급 **30%** / 레어 **12%** / 전설 **3%**',
          '보스 등급: 일반 **35%** / 고급 **35%** / 레어 **22%** / 전설 **8%**',
          '보물상자 등급: 일반 **50%** / 고급 **30%** / 레어 **15%** / 전설 **5%**',
          '같은 등급 조각 **10개**로 아직 보유하지 않은 해당 등급 스킬 1개를 무작위 제작',
        ].join('\n'),
      },
      {
        name: '🛡️ 장비 등급·강화',
        value: [
          '장비 등급은 층이 높을수록 전설·레어·고급 확률이 상승합니다.',
          '예시 — 1층: 일반 75% / 고급 20% / 레어 5% / 전설 0%',
          '5층: 일반 64% / 고급 24% / 레어 11% / 전설 1%',
          '10층: 일반 46.5% / 고급 29% / 레어 18.5% / 전설 6%',
          '17층 이후: 일반 25% / 고급 35% / 레어 28% / 전설 12%',
          '강화 때 부옵션은 중복 없이 남은 부옵션 종류 중 균등 확률로 1개 추가됩니다.',
        ].join('\n'),
      },
      {
        name: '⚔️ 전투 확률',
        value: [
          '피해량 변동: 계산된 피해의 **90~110%**',
          '치명타: 공격자 자신의 치명타 확률을 따름',
          '다인 파티에서 적의 공격 대상: 살아 있는 파티원 중 균등 확률 (도발 중에는 시전자로 고정)',
          '일반 적 스킬: 기본기 **65%** / 강습 **20%** / 상태이상 공격 **15%**',
          '흡혈 일반 적: 기본기 **50%** / 강습 **20%** / 상태이상 **15%** / 흡혈 **15%**',
          '미믹 스킬: 탐욕의 이빨 **70%** / 황금 포식 **30%**',
          '보스(체력 감소 후): 광역기 **30%** / 처형 **30%** / 재앙 **15%** / 상태이상 **15%** / 회복 **10%**',
          '흡혈 보스(체력 감소 후): 광역기 **25%** / 처형 **25%** / 재앙 **15%** / 상태이상 **15%** / 회복 **10%** / 흡혈 **10%**',
          '보스가 최대 체력이면 회복 기술을 제외하고 나머지 가중치로 다시 계산합니다.',
          '상태이상 공격 선택 시 둔화 또는 지속 피해가 **100% 적용**되며 3번의 자기 턴 동안 유지됩니다.',
          '흡혈 대상: 11~20층, 71~75층, 86~100층 계열 적 · 일반 적은 실제 피해의 **35%**, 보스는 **40%** 회복',
          '명중·회피 확률은 현재 적용하지 않습니다.',
        ].join('\n'),
      },
    )
    .setFooter({ text: '이 확률 정보는 명령어를 실행한 사용자에게만 표시됩니다.' });
}

function createBuffHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('⬆️ 버프 도움말')
    .setDescription('스킬 3개를 조합해 파티 역할을 만드는 강화 효과입니다. 상세 수치는 `/스킬도감`에서 확인할 수 있습니다.')
    .addFields(
      {
        name: '⚔️ 공격·마법 공격 버프',
        value: [
          '**마력 증폭·격려의 노래·검사의 호흡·마검 동조·전장의 군신** 등이 해당합니다.',
          '합연산과 퍼센트 버프가 있으며 공격·마법 공격 퍼센트 증가는 합계 **40%**가 상한입니다.',
        ].join('\n'),
      },
      {
        name: '🛡️ 탱킹·생존 버프',
        value: [
          '**수호 결계**는 방어력을, **철벽 자세·대신 막기·불굴의 맹세**는 받는 피해를 줄입니다.',
          '**마력 장막·신성 방벽·위기 방벽·천상의 성역**의 보호막은 체력보다 먼저 피해를 흡수합니다.',
          '**재생의 씨앗·불굴의 재생**은 대상의 턴 시작마다 체력을 회복합니다.',
        ].join('\n'),
      },
      {
        name: '💨 행동·치명타·종합 버프',
        value: [
          '**바람의 축복·생존자의 발걸음**은 속도와 다음 턴 순서를 즉시 바꿉니다. 속도 버프 합계 상한은 **30%**입니다.',
          '**전투 집중**은 치명타 확률을 높이고, **결집의 깃발·고독한 늑대**는 여러 스탯을 함께 강화합니다.',
        ].join('\n'),
      },
      {
        name: '📌 적용 규칙',
        value: [
          '같은 계열은 중첩하지 않고 더 강한 수치를 유지하면서 지속시간을 갱신합니다.',
          '자신에게 사용한 경우 시전한 턴은 지속시간에서 차감하지 않습니다.',
          '현재 버프와 남은 턴은 전투 상태 및 `/파티원스텟`에서 확인할 수 있습니다.',
          '솔로 태그 스킬은 파티에서 효과가 50%로 감소합니다.',
        ].join('\n'),
      },
    )
    .setFooter({ text: '/도움말 항목:디버프에서 약화 효과도 확인할 수 있습니다.' });
}

function createDebuffHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('⬇️ 디버프 도움말')
    .setDescription('플레이어나 적에게 적용되는 약화 효과입니다. 남은 턴은 효과가 적용되는 대상의 행동을 기준으로 계산됩니다.')
    .addFields(
      {
        name: '🛡️ 수호자의 도발 · 적 디버프',
        value: [
          '대상: 적 1명',
          '효과: 적의 공격 대상을 도발 시전자로 고정',
          '지속: 적의 행동 **3회**',
          '도발 중에는 적이 광역 공격과 회복기를 사용하지 않고 단일 공격만 사용합니다.',
          '시전자가 쓰러지거나 파티에서 이탈하면 즉시 해제됩니다.',
        ].join('\n'),
      },
      {
        name: '🕸️ 플레이어가 적에게 거는 약화',
        value: [
          '**약화의 표식·쇠약의 저주**: 적 공격력 감소',
          '**방어구 가르기·원소 노출·종말의 낙인**: 방어·마법 방어 또는 받는 피해 증가',
          '**쇠약의 저주·시간 왜곡**: 적 속도 감소 및 행동 게이지 지연',
          '적 공격 감소 상한 **35%**, 방어 감소 **40%**, 받는 피해 증가 **30%**입니다.',
        ].join('\n'),
      },
      {
        name: '🐌 몬스터가 거는 둔화',
        value: [
          '플레이어 속도를 감소시키며 행동 게이지와 다음 턴 순서가 즉시 다시 계산됩니다.',
          '지속: 해당 플레이어의 턴 **3회**',
        ].join('\n'),
      },
      {
        name: '☠️ 부식·저주 · 플레이어 지속 피해',
        value: [
          '자신의 턴 시작마다 피해를 받습니다. 일반 부식은 적 공격력 × **0.20**, 보스 저주는 × **0.30**입니다.',
          '보호막과 피해 감소가 지속 피해에도 적용됩니다.',
          '지속: 해당 플레이어의 턴 **3회**',
        ].join('\n'),
      },
      {
        name: '📌 적용 규칙',
        value: [
          '같은 종류의 디버프가 다시 걸리면 효과와 지속시간이 갱신됩니다.',
          '플레이어 디버프는 파티 상태에, 도발은 적 상태에 표시됩니다.',
          '현재 디버프와 남은 턴은 전투 상태 및 `/파티원스텟`에서 확인할 수 있습니다.',
        ].join('\n'),
      },
    )
    .setFooter({ text: '/도움말 항목:버프에서 강화 효과도 확인할 수 있습니다.' });
}

async function createItemHelpEmbed(userId, itemReference) {
  const player = await playerStore.getOrCreate(userId);
  const normalizedReference = itemReference.trim().toLocaleLowerCase('ko-KR');
  const equipment = [
    ...player.equipmentInventory.equipment,
    ...Object.values(player.equipment).filter(Boolean),
  ];

  const potionId = itemReference.startsWith('potion:') ? itemReference.slice('potion:'.length) : null;
  const skillId = itemReference.startsWith('skill:') ? itemReference.slice('skill:'.length) : null;
  const equipmentId = itemReference.startsWith('equipment:') ? itemReference.slice('equipment:'.length) : null;
  const potion = potionId
    ? potionCatalog[potionId]
    : Object.values(potionCatalog).find((entry) =>
      entry.name.toLocaleLowerCase('ko-KR') === normalizedReference,
    );
  if (potion) {
    const owned = player.itemInventory.find((item) => item.id === potion.id)?.quantity ?? 0;
    return new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(`🧪 [${potion.rarity}] ${potion.name}`)
      .addFields(
        { name: '효과', value: getPotionDescription(potion), inline: true },
        { name: '상점 가격', value: `${potion.price}골드`, inline: true },
        { name: '보유 수량', value: `${owned}개`, inline: true },
      );
  }

  const skill = skillId
    ? skillCatalog[skillId]
    : Object.values(skillCatalog).find((entry) =>
      entry.name.toLocaleLowerCase('ko-KR') === normalizedReference,
    );
  if (skill) {
    const owned = player.skillInventory.includes(skill.id);
    return new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle(`✨ [${skill.rarity}] ${skill.name}`)
      .setDescription(formatSkill(skill))
      .addFields({ name: '보유 상태', value: owned ? '보유 중' : '미보유', inline: true });
  }

  const selectedEquipment = equipment.find((item) =>
    item.id === equipmentId ||
    item.id === itemReference ||
    item.name.toLocaleLowerCase('ko-KR') === normalizedReference,
  );
  if (selectedEquipment) {
    const equipped = Object.values(player.equipment).some((item) => item?.id === selectedEquipment.id);
    return new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle(`🛡️ ${formatEquipmentName(selectedEquipment)}`)
      .setDescription(formatEquipmentDetails(selectedEquipment))
      .addFields(
        { name: '보관 위치', value: equipped ? '현재 장착 중' : '장비 인벤토리', inline: true },
        { name: '착용 조건', value: `플레이어 Lv.${selectedEquipment.itemLevel} 이상`, inline: true },
      );
  }

  return null;
}

function createPartyResourceBar(current, maximum, filledBox) {
  const segments = 10;
  if (!Number.isFinite(maximum) || maximum <= 0) return '⬛'.repeat(segments);
  const filled = Math.round(Math.min(1, Math.max(0, current / maximum)) * segments);
  return filledBox.repeat(filled) + '⬛'.repeat(segments - filled);
}

async function createPartyStatEmbeds(adventure) {
  const battle = adventureSystem.battles.get(adventure.id);
  const partyFields = await Promise.all(
    adventure.memberIds.map(async (userId) => {
      const player = await playerStore.getOrCreate(userId);
      const baseStats = battle?.playerStats[userId] ?? calculateTotalStats(player);
      const stats = battle?.playerStats[userId]
        ? adventureSystem.getEffectivePlayerStats(battle, userId)
        : baseStats;
      const health = adventure.healthByUser[userId];
      const maxHealth = adventure.maxHealthByUser[userId];
      const mana = battle?.manaByUser[userId] ?? adventure.manaByUser?.[userId] ?? stats.mana;
      const currentSpeed = battle?.actors.find((actor) => actor.type === 'PLAYER' && actor.userId === userId)?.speed
        ?? stats.speed;
      const statusEffects = battle?.statusEffectsByUser?.[userId] ?? [];
      const buffs = battle ? adventureSystem.getPlayerBuffs(battle, userId) : [];
      return {
        name: `<@${userId}> · Lv.${stats.playerLevel}`,
        value: [
          `❤️ 체력 ${createPartyResourceBar(health, maxHealth, '🟥')} ${health}/${maxHealth}`,
          `🔷 마나 ${createPartyResourceBar(mana, stats.mana, '🟦')} ${mana}/${stats.mana}`,
          `🛡️ 방어력 ${stats.defense}\t⚔️ 공격력 ${stats.attack}\t✨ 마법 공격력 ${stats.magicAttack}`,
          `💨 속도 ${currentSpeed}${currentSpeed !== baseStats.speed ? ` (기본 ${baseStats.speed})` : ''}\t🎯 치명타 ${stats.criticalChance}%\t💥 치명타 피해 ${stats.criticalDamage}%`,
          `⬆️ 버프: ${buffs.length > 0 ? buffs.map((buff) => adventureSystem.formatPlayerBuff(buff)).join(', ') : '없음'}`,
          `⬇️ 디버프: ${statusEffects.length > 0 ? statusEffects.map((effect) => `${effect.name}(${effect.remainingTurns}턴)`).join(', ') : '없음'}`,
        ].join('\n'),
        inline: false,
      };
    }),
  );
  const embeds = [];
  if (battle) {
    const monsterBuffs = battle.monsterBuffs ?? [];
    const monsterDebuffs = battle.monsterDebuffs ?? [];
    embeds.push(
      new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle(`👹 Lv.${battle.monster.level} ${battle.monster.name} 상태`)
        .setDescription([
          `❤️ 체력 ${createPartyResourceBar(battle.monster.health, battle.monster.maxHealth, '🟥')} ${battle.monster.health}/${battle.monster.maxHealth}`,
          `⬆️ 버프: ${monsterBuffs.length > 0 ? monsterBuffs.map((buff) => `${buff.name}(${buff.remainingTurns}턴)`).join(', ') : '없음'}`,
          `⬇️ 디버프: ${monsterDebuffs.length > 0 ? monsterDebuffs.map((debuff) => adventureSystem.formatMonsterDebuff(debuff)).join(', ') : '없음'}`,
        ].join('\n')),
    );
  }
  for (let index = 0; index < partyFields.length; index += 25) {
    const page = Math.floor(index / 25) + 1;
    const pageCount = Math.ceil(partyFields.length / 25);
    embeds.push(
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`⚔️ ${adventure.floor}층 파티원 스탯${pageCount > 1 ? ` (${page}/${pageCount})` : ''}`)
        .addFields(partyFields.slice(index, index + 25)),
    );
  }
  return embeds;
}

client.once(Events.ClientReady, async (readyClient) => {
  if (readyClient.user.username !== BOT_DISPLAY_NAME) {
    try {
      await readyClient.user.setUsername(BOT_DISPLAY_NAME);
      console.log(`봇 이름을 ${BOT_DISPLAY_NAME}(으)로 변경했습니다.`);
    } catch (error) {
      console.error(`봇 이름을 ${BOT_DISPLAY_NAME}(으)로 변경하지 못했습니다.`, error);
    }
  }
  console.log(`${readyClient.user.tag}(으)로 로그인했습니다.`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === '도움말') {
        const focusedValue = interaction.options.getFocused().toLocaleLowerCase('ko-KR');
        const player = await playerStore.getOrCreate(interaction.user.id);
        const equipment = [
          ...player.equipmentInventory.equipment,
          ...Object.values(player.equipment).filter(Boolean),
        ];
        const choices = [
          ...Object.values(potionCatalog).map((potion) => ({
            name: `[포션] [${potion.rarity}] ${potion.name}`,
            value: `potion:${potion.id}`,
          })),
          ...Object.values(skillCatalog).map((skill) => ({
            name: `[스킬] [${skill.rarity}] ${skill.name}`,
            value: `skill:${skill.id}`,
          })),
          ...equipment.map((item) => ({
            name: `[장비] ${formatEquipmentName(item)} · 고유 Lv.${item.itemLevel}`.slice(0, 100),
            value: `equipment:${item.id}`,
          })),
        ]
          .filter((choice) => choice.name.toLocaleLowerCase('ko-KR').includes(focusedValue))
          .slice(0, 25);
        await interaction.respond(choices);
        return;
      }

      if (interaction.commandName === 'give') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          await interaction.respond([]);
          return;
        }
        const focusedValue = interaction.options.getFocused().toLocaleLowerCase('ko-KR');
        const matchingOptions = debugGiveOptions.filter((option) =>
          option.name.toLocaleLowerCase('ko-KR').includes(focusedValue),
        );
        const options = focusedValue
          ? matchingOptions
          : [
              ...matchingOptions.filter((option) => option.value.startsWith('equipment:')),
              ...matchingOptions.filter((option) => !option.value.startsWith('equipment:')),
            ];
        await interaction.respond(
          options.slice(0, 25),
        );
        return;
      }

      if (interaction.commandName === '스킬장착') {
        const player = await playerStore.getOrCreate(interaction.user.id);
        const focusedValue = interaction.options.getFocused().toLocaleLowerCase('ko-KR');
        const choices = player.skillInventory
          .map((skillId) => getSkill(skillId))
          .filter(
            (skill) =>
              skill &&
              `${skill.name} ${skill.rarity}`.toLocaleLowerCase('ko-KR').includes(focusedValue),
          )
          .slice(0, 25)
          .map((skill) => ({ name: `[${skill.rarity}] ${skill.name}`, value: skill.id }));
        await interaction.respond(choices);
        return;
      }

      if (interaction.commandName === '적도감') {
        const focusedValue = interaction.options.getFocused().toLocaleLowerCase('ko-KR');
        const choices = monsterCatalogEntries
          .filter((entry) =>
            `${entry.name} ${entry.region.regionName} ${entry.minFloor} ${entry.maxFloor}`
              .toLocaleLowerCase('ko-KR')
              .includes(focusedValue),
          )
          .slice(0, 25)
          .map((entry) => ({
            name: `${entry.type === 'BOSS' ? '[보스]' : entry.type === 'MIMIC' ? '[특수]' : '[일반]'} ${entry.name} · ${entry.type === 'MIMIC' ? '특수 사건' : `${entry.minFloor}~${entry.maxFloor}층`}`.slice(0, 100),
            value: entry.id,
          }));
        await interaction.respond(choices);
        return;
      }

      if (interaction.commandName === '스킬장착해제') {
        if (adventureManager.getByUser(interaction.user.id)) {
          await interaction.reply({
            content: '모험 중에는 스킬 장착을 해제할 수 없습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const slot = interaction.options.getInteger('슬롯', true);
        const result = await playerStore.unequipSkill(interaction.user.id, slot);
        if (!result.ok && result.reason === 'EMPTY_SLOT') {
          await interaction.reply({
            content: `${result.slot}번 슬롯은 이미 비어 있습니다.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (!result.ok) {
          await interaction.reply({ content: '올바르지 않은 스킬 슬롯입니다.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({
          content: `✅ ${result.slot}번 슬롯의 [${result.skill.rarity}] ${result.skill.name} 장착을 해제했습니다.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!['장비장착', '장비강화', '장비분해', '장비잠금'].includes(interaction.commandName)) {
        await interaction.respond([]);
        return;
      }
      const player = await playerStore.getOrCreate(interaction.user.id);
      const focusedValue = interaction.options.getFocused().toLocaleLowerCase('ko-KR');
      const availableEquipment = ['장비잠금', '장비강화'].includes(interaction.commandName)
        ? [
            ...player.equipmentInventory.equipment,
            ...Object.values(player.equipment).filter(Boolean),
          ]
        : player.equipmentInventory.equipment;
      const selectableEquipment = availableEquipment;
      const choices = selectableEquipment
        .filter((item) =>
          `${item.name} ${item.rarity} ${item.itemLevel}`
            .toLocaleLowerCase('ko-KR')
            .includes(focusedValue),
        )
        .slice(0, 25)
        .map((item) => {
          const levelBlocked =
            interaction.commandName === '장비장착' && item.itemLevel > player.stats.playerLevel;
          const location = Object.values(player.equipment).includes(item) ? '[장착 중]' : '[인벤토리]';
          const status = levelBlocked ? `[장착 불가 · Lv.${item.itemLevel} 필요]` : location;
          return {
            name: `${status} ${formatEquipmentName(item)} · 고유 Lv.${item.itemLevel}`.slice(0, 100),
            value: item.id,
          };
        });
      await interaction.respond(choices);
      return;
    }

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === '디버그') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          await interaction.reply({
            content: '이 명령어는 서버 관리자만 사용할 수 있습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const group = interaction.options.getSubcommandGroup(true);
        const subcommand = interaction.options.getSubcommand(true);
        if (group === '모험' && subcommand === '다음층이동') {
          const adventure = adventureManager.getByUser(interaction.user.id);
          if (!adventure) {
            await interaction.reply({
              content: '현재 참여 중인 모험이 없습니다.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          if (interaction.channelId !== adventure.textChannelId) {
            await interaction.reply({
              content: '현재 모험의 `던전-전투` 채널에서 사용해 주세요.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          await interaction.reply({
            content: `🛠️ 디버그 명령으로 ${adventure.floor + 1}층 이동을 시작합니다.`,
            flags: MessageFlags.Ephemeral,
          });
          await adventureSystem.moveToNextFloor(adventure, interaction.channel);
          return;
        }
        if (group === '모험' && subcommand === '킬') {
          const adventure = adventureManager.getByUser(interaction.user.id);
          if (!adventure) {
            await interaction.reply({
              content: '현재 참여 중인 모험이 없습니다.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          if (interaction.channelId !== adventure.textChannelId) {
            await interaction.reply({
              content: '현재 모험의 `던전-전투` 채널에서 사용해 주세요.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const battle = adventureSystem.battles.get(adventure.id);
          if (!battle) {
            await interaction.reply({
              content: '현재 전투 중인 몬스터가 없습니다.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          if (battle.debugKillInProgress) {
            await interaction.reply({
              content: '이미 디버그 처치가 처리 중입니다.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          battle.debugKillInProgress = true;
          await interaction.reply({
            content: `🛠️ 디버그 명령으로 **Lv.${battle.monster.level} ${battle.monster.name}**을(를) 즉시 처치합니다.`,
            flags: MessageFlags.Ephemeral,
          });
          battle.monster.health = 0;
          adventure.currentActionToken = null;
          await battle.turnMessage?.edit({ components: [] }).catch(() => {});
          await interaction.channel.send(
            `# 🛠️ 관리자 디버그 킬\n**Lv.${battle.monster.level} ${battle.monster.name}**을(를) 즉시 처치했습니다.`,
          );
          await adventureSystem.finishBattleVictory(adventure, battle);
          return;
        }
      }

      if (interaction.commandName === 'give') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
          return;
        }
        const target = interaction.options.getUser('플레이어', true);
        if (target.bot) {
          await interaction.reply({ content: '봇 계정에는 아이템을 지급할 수 없습니다.', flags: MessageFlags.Ephemeral });
          return;
        }
        const selected = interaction.options.getString('아이템', true);
        const quantity = interaction.options.getInteger('수량') ?? 1;
        const availableOption = debugGiveOptions.find((option) => option.value === selected);
        if (!availableOption) {
          await interaction.reply({ content: '자동완성 목록에서 올바른 아이템을 선택해 주세요.', flags: MessageFlags.Ephemeral });
          return;
        }
        const [type, first, second] = selected.split(':');
        let itemText;
        if (type === 'potion') {
          const potion = potionCatalog[first];
          await playerStore.addItem(target.id, potion.id, quantity);
          itemText = `[${potion.rarity}] ${potion.name} ${quantity.toLocaleString('ko-KR')}개`;
        } else if (type === 'skill') {
          const result = await playerStore.learnSkill(target.id, first);
          itemText = `[${result.skill.rarity}] ${result.skill.name}`;
        } else if (type === 'currency') {
          await playerStore.addDebugResources(target.id, { gold: quantity });
          itemText = `골드 ${quantity.toLocaleString('ko-KR')}`;
        } else if (type === 'material') {
          await playerStore.addDebugResources(target.id, { magicStones: quantity });
          itemText = `마석 ${quantity.toLocaleString('ko-KR')}개`;
        } else {
          if (quantity > 100) {
            await interaction.reply({
              content: '장비는 한 번에 최대 100개까지 지급할 수 있습니다.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const player = await playerStore.getOrCreate(target.id);
          let sampleItem;
          for (let index = 0; index < quantity; index += 1) {
            const item = createEquipment({
              name: getEquipmentName(first, second),
              itemLevel: player.stats.playerLevel,
              rarity: first,
              slot: second,
            });
            sampleItem ??= item;
            await playerStore.addAdventureReward(target.id, 0, item);
          }
          itemText = `${formatEquipmentName(sampleItem)} (고유 Lv.${sampleItem.itemLevel}) ${quantity.toLocaleString('ko-KR')}개`;
        }
        await interaction.reply({
          content: `✅ 관리자 디버그 지급: <@${target.id}>님에게 **${itemText}**을(를) 지급했습니다.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === '항복') {
        const session = pvpManager.getByUser(interaction.user.id);
        if (!session) {
          await interaction.reply({
            content: '현재 참여 중인 PVP 결투가 없습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (interaction.channelId !== session.textChannelId) {
          await interaction.reply({
            content: '항복은 결투 전용 `채팅-콜로세움`에서만 사용할 수 있습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const winnerId = session.memberIds.find((userId) => userId !== interaction.user.id);
        await interaction.reply(
          `# 🏳️ 항복\n<@${interaction.user.id}>님이 항복했습니다.\n# 🏆 <@${winnerId}>님 승리!`,
        );
        await pvpManager.end(client, session.id, '플레이어 항복');
        return;
      }

      if (interaction.commandName === '결투신청') {
        const challenger = interaction.member;
        const opponent = interaction.options.getMember('상대');
        if (!challenger?.voice.channelId) {
          await interaction.reply({ content: '먼저 음성 채널에 들어가 주세요.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (!opponent || opponent.user.bot || opponent.id === challenger.id) {
          await interaction.reply({ content: '자신이나 봇에게는 결투를 신청할 수 없습니다.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (opponent.voice.channelId !== challenger.voice.channelId) {
          await interaction.reply({ content: '결투 상대가 같은 음성 채널에 있어야 합니다.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (
          adventureManager.getByUser(challenger.id) || adventureManager.getByUser(opponent.id) ||
          pendingInvitationByUser.has(challenger.id) || pendingInvitationByUser.has(opponent.id) ||
          pvpManager.getByUser(challenger.id) || pvpManager.getByUser(opponent.id) ||
          hasPendingDuel(challenger.id) || hasPendingDuel(opponent.id)
        ) {
          await interaction.reply({ content: '두 플레이어 중 한 명이 이미 모험, 결투 또는 결투 신청 중입니다.', flags: MessageFlags.Ephemeral });
          return;
        }

        const duelId = randomUUID();
        const row = createChoiceButtons('duel_invite', duelId, '결투 수락', '결투 거절');
        const message = await interaction.reply({
          content: `# ⚔️ 결투 신청\n<@${challenger.id}>님이 <@${opponent.id}>님에게 결투를 신청했습니다.\n30초 안에 선택해 주세요.`,
          components: [row],
          withResponse: true,
        });
        const duel = {
          id: duelId,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          voiceChannelId: challenger.voice.channelId,
          challengerId: challenger.id,
          opponentId: opponent.id,
          message: message.resource?.message,
          timeout: null,
        };
        pendingDuels.set(duelId, duel);
        duel.timeout = setTimeout(async () => {
          if (!pendingDuels.delete(duelId)) return;
          await duel.message?.edit({ content: '⌛ 결투 신청 시간이 만료됐습니다.', components: [] }).catch(() => {});
        }, DUEL_INVITATION_DURATION_MS);
        return;
      }

      if (interaction.commandName === '전체초기화') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          await interaction.reply({
            content: '이 명령어는 서버 관리자만 사용할 수 있습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (interaction.options.getString('확인', true) !== '전체초기화') {
          await interaction.reply({
            content: '초기화가 취소되었습니다. 확인란에 `전체초기화`를 정확히 입력해야 합니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (adventureManager.adventures.size > 0) {
          await interaction.reply({
            content: '진행 중인 모험이 있어 초기화할 수 없습니다. 모든 모험이 끝난 뒤 다시 실행해 주세요.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const result = await playerStore.resetAllPlayers();
        await interaction.reply({
          content: `✅ 플레이어 **${result.resetCount}명**의 스탯, 장비, 인벤토리, 골드, 스킬, 경험치와 체크포인트를 모두 초기화했습니다.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === '도움말') {
        const itemReference = interaction.options.getString('아이템이름');
        if (itemReference) {
          const itemEmbed = await createItemHelpEmbed(interaction.user.id, itemReference);
          await interaction.reply({
            content: itemEmbed ? undefined : '해당 아이템을 찾지 못했습니다. 자동완성 목록에서 선택해 주세요.',
            embeds: itemEmbed ? [itemEmbed] : [],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const helpTopic = interaction.options.getString('항목');
        const helpEmbedByTopic = {
          확률: createProbabilityHelpEmbed,
          버프: createBuffHelpEmbed,
          디버프: createDebuffHelpEmbed,
        };
        const createSelectedHelpEmbed = helpEmbedByTopic[helpTopic] ?? createHelpEmbed;
        await interaction.reply({
          embeds: [createSelectedHelpEmbed()],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === '가이드북') {
        await interaction.reply({
          embeds: [createGuidebookEmbed()],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === '파티원스텟') {
        const adventure = adventureManager.getByUser(interaction.user.id);
        if (!adventure || interaction.channelId !== adventure.textChannelId) {
          await interaction.reply({
            content: '현재 참여 중인 모험의 전투 채널에서만 사용할 수 있습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await interaction.reply({ embeds: await createPartyStatEmbeds(adventure) });
        return;
      }

      if (interaction.commandName === 'ping') {
        await interaction.reply(`Pong! 지연 시간: ${client.ws.ping}ms`);
        return;
      }

      if (interaction.commandName === '게임시작') {
        await interaction.reply({
          content: '가위, 바위, 보 중 하나를 선택하세요!',
          components: [createGameButtons()],
        });
        return;
      }

      if (interaction.commandName === '내정보') {
        const player = await playerStore.getOrCreate(interaction.user.id);
        await interaction.reply({
          embeds: [createPlayerEmbed(interaction.user, player)],
        });
        return;
      }

      if (interaction.commandName === '랭킹') {
        const categoryName = interaction.options.getSubcommand();
        await interaction.reply({ embeds: [await createRankingEmbed(categoryName)] });
        return;
      }

      if (interaction.commandName === '정보') {
        const target = interaction.options.getUser('플레이어', true);
        if (isDicoBotEasterEggTarget(interaction, target)) {
          await interaction.reply({ embeds: [createDicoBotEasterEggEmbed(target)] });
          return;
        }
        if (target.bot) {
          await interaction.reply({
            content: '봇 계정의 던전 정보는 확인할 수 없습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const player = await playerStore.getOrCreate(target.id);
        await interaction.reply({
          embeds: [createPlayerEmbed(target, player)],
        });
        return;
      }

      if (interaction.commandName === '장비인벤토리') {
        const player = await playerStore.getOrCreate(interaction.user.id);
        await interaction.reply({
          embeds: [createEquipmentInventoryEmbed(interaction.user, player)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === '아이템인벤토리') {
        const player = await playerStore.getOrCreate(interaction.user.id);
        await interaction.reply({
          embeds: [createItemInventoryEmbed(interaction.user, player)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === '스킬북') {
        const player = await playerStore.getOrCreate(interaction.user.id);
        await interaction.reply({
          embeds: createSkillInventoryEmbeds(interaction.user, player),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === '스킬도감') {
        const player = await playerStore.getOrCreate(interaction.user.id);
        await interaction.reply({
          ...createSkillCatalogPage(interaction.user, player),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === '스킬제작') {
        if (adventureManager.getByUser(interaction.user.id)) {
          await interaction.reply({
            content: '모험 중에는 스킬을 제작할 수 없습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const rarity = interaction.options.getString('등급', true);
        const result = await playerStore.craftSkill(interaction.user.id, rarity);
        if (!result.ok && result.reason === 'NOT_ENOUGH_FRAGMENTS') {
          await interaction.reply({
            content: `🧩 **${rarity} 스킬 조각**이 부족합니다. ${result.availableFragments}/10개 보유 중입니다.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (!result.ok && result.reason === 'ALL_OWNED') {
          await interaction.reply({
            content: `이미 **${rarity}** 등급의 모든 스킬을 보유하고 있습니다. 조각은 소비되지 않았습니다.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (!result.ok) {
          await interaction.reply({ content: '스킬 제작에 실패했습니다.', flags: MessageFlags.Ephemeral });
          return;
        }
        const attachmentName = 'skill-crafting-altar.png';
        const attachment = new AttachmentBuilder(skillCraftingImagePath, { name: attachmentName });
        const embed = new EmbedBuilder()
          .setColor(0xf1c40f)
          .setTitle('✨ 스킬 제작 성공!')
          .setDescription([
            `🧩 **${rarity} 스킬 조각 10개**를 사용했습니다.`,
            `## ✨ 획득: [${result.skill.rarity}] ${result.skill.name}`,
            formatSkill(result.skill),
            `남은 ${rarity} 조각: **${result.remainingFragments}개**`,
          ].join('\n\n'))
          .setImage(`attachment://${attachmentName}`)
          .setFooter({ text: '스킬북에서 새 스킬을 장착할 수 있습니다.' });
        await interaction.reply({
          embeds: [embed],
          files: [attachment],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === '적도감') {
        const monsterReference = interaction.options.getString('적이름');
        if (!monsterReference) {
          await interaction.reply({
            embeds: [createMonsterCatalogListEmbed()],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const entry = monsterCatalogEntries.find(
          (candidate) => candidate.id === monsterReference || candidate.name === monsterReference,
        );
        if (!entry) {
          await interaction.reply({
            content: '해당 적을 찾지 못했습니다. 자동완성 목록에서 선택해 주세요.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await interaction.reply({
          ...createMonsterCatalogDetailPayload(entry),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === '스킬장착') {
        if (adventureManager.getByUser(interaction.user.id)) {
          await interaction.reply({
            content: '모험 중에는 스킬 장착을 변경할 수 없습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const skillId = interaction.options.getString('스킬', true);
        const slot = interaction.options.getInteger('슬롯', true);
        const result = await playerStore.equipSkill(interaction.user.id, skillId, slot);
        if (!result.ok) {
          await interaction.reply({
            content: '보유 스킬에서 해당 스킬을 찾지 못했습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await interaction.reply({
          content: `✅ [${result.skill.rarity}] ${result.skill.name}을(를) **${result.slot}번 슬롯**에 장착했습니다.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === '상점') {
        if (adventureManager.getByUser(interaction.user.id)) {
          await interaction.reply({
            content: '모험 중에는 상점을 이용할 수 없습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const player = await playerStore.getOrCreate(interaction.user.id);
        await interaction.reply(createShopPayload(interaction.user, player));
        return;
      }

      if (interaction.commandName === '장비장착') {
        if (adventureManager.getByUser(interaction.user.id)) {
          await interaction.reply({
            content: '모험 중에는 장비를 변경할 수 없습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const itemName = interaction.options.getString('아이템이름', true);
        const result = await playerStore.equipItem(interaction.user.id, itemName);

        if (!result.ok) {
          const content = result.reason === 'LEVEL_TOO_LOW'
            ? [
                `레벨이 부족하여 ${formatEquipmentName(result.item)}을(를) 장착할 수 없습니다.`,
                `필요 레벨: **Lv.${result.requiredLevel}** · 현재 레벨: **Lv.${result.playerLevel}**`,
              ].join('\n')
            : '장비 인벤토리에서 해당 아이템을 찾지 못했습니다. 자동완성 목록에서 다시 선택해 주세요.';
          await interaction.reply({
            content,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const previousMessage = result.previousItem
          ? ` 기존 ${formatEquipmentName(result.previousItem)}은(는) 인벤토리로 이동했습니다.`
          : '';
        await interaction.reply({
          content: `✅ ${formatEquipmentName(result.item)}을(를) **${result.item.slot}** 슬롯에 장착했습니다.${previousMessage}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === '자동장착') {
        if (adventureManager.getByUser(interaction.user.id)) {
          await interaction.reply({
            content: '모험 중에는 장비를 변경할 수 없습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const result = await playerStore.autoEquipBest(interaction.user.id);
        if (result.changes.length === 0) {
          await interaction.reply({
            content: [
              '현재 이미 장착 가능한 장비 중 가장 우선순위가 높은 장비를 착용하고 있습니다.',
              result.skippedEquipment.length > 0
                ? `-# 플레이어 레벨(${result.playerLevel})보다 높은 고유 레벨 장비 ${result.skippedEquipment.length}개는 제외했습니다.`
                : null,
            ].filter(Boolean).join('\n'),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const changeLines = result.changes.map(({ slot, item }) =>
          item
            ? `**[${slot}]** ${formatEquipmentName(item)} · 고유 Lv.${item.itemLevel}`
            : `**[${slot}]** 비어 있음`,
        );
        await interaction.reply({
          content: [
            '✅ 자동 장착을 완료했습니다.',
            `-# 플레이어 Lv.${result.playerLevel} 이하 장비만 대상 · 우선순위: 고유 레벨 → 등급 → 강화 단계`,
            result.skippedEquipment.length > 0
              ? `-# 고유 레벨이 더 높은 장비 ${result.skippedEquipment.length}개는 인벤토리에 유지했습니다.`
              : null,
            ...changeLines,
          ].filter(Boolean).join('\n'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === '장비강화') {
        if (adventureManager.getByUser(interaction.user.id)) {
          await interaction.reply({
            content: '모험 중에는 장비를 강화할 수 없습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const itemName = interaction.options.getString('아이템이름', true);
        const result = await playerStore.enhanceInventoryItem(
          interaction.user.id,
          itemName,
          enhanceEquipment,
        );

        if (!result.ok && result.reason === 'NOT_FOUND') {
          await interaction.reply({
            content: `보유 또는 장착 중인 장비에서 **${itemName}** 아이템을 찾지 못했습니다.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!result.ok && result.reason === 'MAX') {
          await interaction.reply({
            content: `${formatEquipmentName(result.item)}은(는) 최대 강화 단계인 +${getMaxEnhancement(result.item)}입니다.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!result.ok && result.reason === 'NOT_ENOUGH_MAGIC_STONES') {
          await interaction.reply({
            content: [
              `${formatEquipmentName(result.item)}의 다음 강화에는 **마석 ${result.requiredMagicStones}개**가 필요합니다.`,
              `현재 보유량: **${result.ownedMagicStones}개**`,
            ].join('\n'),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const attachmentName = 'equipment-enhancement.png';
        const attachment = new AttachmentBuilder(enhancementImagePath, { name: attachmentName });
        const embed = new EmbedBuilder()
          .setColor(0xf1c40f)
          .setTitle('🔨✨ 장비 강화 성공!')
          .setDescription([
            result.equippedSlot ? `현재 **${result.equippedSlot}** 슬롯에 장착 중인 장비입니다.` : '장비 인벤토리에 보관 중인 장비입니다.',
            '',
            formatEquipmentDetails(result.item),
            '',
            `사용한 마석: **${result.usedMagicStones}개** · 남은 마석: **${result.remainingMagicStones}개**`,
          ].join('\n'))
          .setImage(`attachment://${attachmentName}`);
        await interaction.reply({
          embeds: [embed],
          files: [attachment],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === '장비분해') {
        if (adventureManager.getByUser(interaction.user.id)) {
          await interaction.reply({
            content: '모험 중에는 장비를 분해할 수 없습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const itemIdentifier = interaction.options.getString('장비', true);
        const result = await playerStore.dismantleEquipment(
          interaction.user.id,
          itemIdentifier,
        );
        if (!result.ok) {
          const content = result.reason === 'LOCKED'
            ? `🔒 ${formatEquipmentName(result.item)}은(는) 잠긴 장비입니다. 먼저 /장비잠금에서 잠금을 해제해 주세요.`
            : '장비 인벤토리에서 해당 장비를 찾지 못했습니다.';
          await interaction.reply({
            content,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await interaction.reply({
          content: [
            `🔨 ${formatEquipmentName(result.item)}을(를) 분해했습니다.`,
            `획득한 마석: **${result.magicStones}개**`,
            `현재 보유 마석: **${result.totalMagicStones}개**`,
          ].join('\n'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === '장비일괄분해') {
        if (adventureManager.getByUser(interaction.user.id)) {
          await interaction.reply({
            content: '모험 중에는 장비를 분해할 수 없습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const maxItemLevel = interaction.options.getInteger('고유레벨이하');
        const maxRarity = interaction.options.getString('등급이하');
        if (maxItemLevel === null && maxRarity === null) {
          await interaction.reply({
            content: '`고유레벨이하` 또는 `등급이하` 조건을 하나 이상 지정해 주세요.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const result = await playerStore.dismantleEquipmentBulk(interaction.user.id, {
          maxItemLevel,
          maxRarity,
        });
        if (!result.ok) {
          await interaction.reply({
            content: result.lockedExcluded > 0
              ? `조건에 맞는 장비는 모두 잠겨 있어 분해하지 않았습니다. 잠금 보호 장비: **${result.lockedExcluded}개**`
              : '조건에 맞는 분해 가능한 장비가 없습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const conditions = [
          maxItemLevel !== null ? `고유 Lv.${maxItemLevel} 이하` : null,
          maxRarity !== null ? `${maxRarity} 등급 이하` : null,
        ].filter(Boolean).join(' + ');
        await interaction.reply({
          content: [
            `🔨 **장비 ${result.dismantledCount}개**를 일괄 분해했습니다.`,
            `적용 조건: **${conditions}**`,
            `획득한 마석: **${result.magicStones}개**`,
            `현재 보유 마석: **${result.totalMagicStones}개**`,
            result.lockedExcluded > 0
              ? `🔒 조건에 맞지만 잠겨 있어 보호된 장비: **${result.lockedExcluded}개**`
              : null,
          ].filter(Boolean).join('\n'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === '장비잠금') {
        const itemIdentifier = interaction.options.getString('장비', true);
        const lockState = interaction.options.getString('상태', true);
        const result = await playerStore.setEquipmentLock(
          interaction.user.id,
          itemIdentifier,
          lockState === 'lock',
        );
        if (!result.ok) {
          await interaction.reply({
            content: '보유 장비에서 해당 장비를 찾지 못했습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await interaction.reply({
          content: result.locked
            ? `🔒 ${formatEquipmentName(result.item)}을(를) 잠갔습니다. 잠금을 해제하기 전에는 분해할 수 없습니다.`
            : `🔓 ${formatEquipmentName(result.item)}의 잠금을 해제했습니다.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === '모험시작') {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (member.voice.channel?.name !== ENTRANCE_CHANNEL_NAME) {
          await interaction.reply({
            content: '먼저 **던전입장** 음성 채널에 들어가 주세요.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (adventureManager.getByUser(member.id) || pvpManager.getByUser(member.id)) {
          await interaction.reply({
            content: '이미 진행 중인 모험 또는 결투가 있습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (pendingInvitationByUser.has(member.id)) {
          await interaction.reply({
            content: '이미 진행 중인 공대 모집이 있습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (hasPendingDuel(member.id)) {
          await interaction.reply({
            content: '진행 중인 결투 신청에 먼저 응답해 주세요.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const lobbyMembers = [...member.voice.channel.members.values()].filter(
          (candidate) => !candidate.user.bot,
        );
        if (lobbyMembers.some((candidate) => pendingInvitationByUser.has(candidate.id))) {
          await interaction.reply({
            content: '던전입장 채널에서 이미 다른 공대 모집이 진행 중입니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (lobbyMembers.length === 1) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const player = await playerStore.getOrCreate(member.id);
          const maxHealth = calculateTotalStats(player).health;
          const result = await adventureManager.startParty(
            interaction.guild,
            member,
            [member],
            { [member.id]: maxHealth },
          );
          if (!result.ok) {
            await interaction.editReply(
              '모험을 시작하지 못했습니다. 봇의 채널 관리 및 멤버 이동 권한을 확인해 주세요.',
            );
            return;
          }
          await startAdventureAfterPenaltyWarning(result.adventure);
          await interaction.editReply(
            `⚔️ 1인 모험을 시작했습니다! <#${result.adventure.textChannelId}> 채널에서 전투를 진행합니다.`,
          );
          return;
        }

        const invitation = {
          id: randomUUID(),
          guildId: interaction.guild.id,
          channelId: interaction.channelId,
          entranceChannelId: member.voice.channelId,
          leaderId: member.id,
          invitedIds: lobbyMembers.map((candidate) => candidate.id),
          acceptedIds: new Set([member.id]),
          declinedIds: new Set(),
          message: null,
          timeout: null,
          closing: false,
        };
        const row = createChoiceButtons('adventure_join', invitation.id, '동행하기', '거절하기');
        await interaction.reply({
          content: invitationText(invitation),
          components: [row],
          allowedMentions: { users: invitation.invitedIds },
        });
        invitation.message = await interaction.fetchReply();
        pendingInvitations.set(invitation.id, invitation);
        for (const userId of invitation.invitedIds) {
          pendingInvitationByUser.set(userId, invitation.id);
        }
        invitation.timeout = setTimeout(() => finishInvitation(invitation.id), INVITATION_DURATION_MS);
        return;
      }

      if (interaction.commandName === '모험중지') {
        const adventure = adventureManager.getByUser(interaction.user.id);
        if (!adventure) {
          await interaction.reply({
            content: '현재 진행 중인 모험이 없습니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const battle = adventureSystem.battles.get(adventure.id);
        if (battle && !canStopDuringBattle(battle)) {
          await interaction.reply({
            content: '⚔️ 파티의 공격과 피격이 모두 발생한 전투 중에는 모험을 중지할 수 없습니다. 전투가 끝난 뒤 다시 시도해 주세요.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (interaction.channelId !== adventure.textChannelId) {
          await interaction.reply({
            content: `모험 중지는 전용 전투 채널 <#${adventure.textChannelId}>에서만 사용할 수 있습니다.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (adventure.memberIds.length === 1) {
          await interaction.reply({
            content: '🛑 모험을 종료합니다.',
            flags: MessageFlags.Ephemeral,
          });
          adventureSystem.cleanup(adventure.id);
          await adventureManager.end(client, adventure.id, 'SOLO_STOP_COMMAND');
          return;
        }

        if (stopVotes.has(adventure.id)) {
          await interaction.reply({
            content: '이미 모험 중지 투표가 진행 중입니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const textChannel = interaction.guild.channels.cache.get(adventure.textChannelId);
        const vote = {
          adventureId: adventure.id,
          memberIds: [...adventure.memberIds],
          startedBy: interaction.user.id,
          yesIds: new Set([interaction.user.id]),
          noIds: new Set(),
          message: null,
          timeout: null,
        };
        stopVotes.set(adventure.id, vote);
        vote.message = await textChannel.send({
          content: stopVoteText(vote),
          components: [createChoiceButtons('adventure_stop', adventure.id, '중지 찬성', '중지 반대')],
        });
        vote.timeout = setTimeout(
          () => closeStopVote(vote, '⌛ 모험 중지 투표가 시간 초과로 부결됐습니다.'),
          STOP_VOTE_DURATION_MS,
        );
        await interaction.reply({
          content: `모험 전용 채널에서 중지 투표를 시작했습니다. 과반수인 **${Math.floor(vote.memberIds.length / 2) + 1}표**가 필요합니다.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('shop:')) {
      const [, action, itemId, ownerId] = interaction.customId.split(':');
      if (interaction.user.id !== ownerId) {
        await interaction.reply({
          content: '이 상점은 명령어를 실행한 사용자만 이용할 수 있습니다.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (adventureManager.getByUser(ownerId)) {
        await interaction.reply({
          content: '모험 중에는 상점을 이용할 수 없습니다.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (action === 'sell') {
        const result = await playerStore.sellItem(ownerId, itemId);
        if (!result.ok) {
          await interaction.reply({
            content: result.reason === 'NOT_OWNED' ? '판매할 포션을 보유하고 있지 않습니다.' : '존재하지 않는 상품입니다.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await interaction.reply({
          content: `✅ ${result.potion.name} 1개를 **${result.salePrice}골드**에 판매했습니다. 남은 수량: **${result.remaining}개** · 보유 골드: **${result.gold}**`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (action === 'material' && itemId === 'magic_stone') {
        const result = await playerStore.buyMagicStone(ownerId, 500);
        if (!result.ok) {
          await interaction.reply({
            content: `마석 교환에는 **${result.price}골드**가 필요합니다. 현재 골드: **${result.gold}**`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await interaction.reply({
          content: `✅ **500골드**를 사용해 마석 1개를 교환했습니다. 보유 마석: **${result.magicStones}개** · 남은 골드: **${result.gold}**`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (action !== 'buy') {
        await interaction.reply({ content: '올바르지 않은 상점 동작입니다.', flags: MessageFlags.Ephemeral });
        return;
      }
      const result = await playerStore.buyItem(ownerId, itemId);
      if (!result.ok && result.reason === 'NOT_ENOUGH_GOLD') {
        await interaction.reply({
          content: `${result.potion.name} 구매에 **${result.potion.price}골드**가 필요합니다. 현재 골드: **${result.gold}**`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!result.ok) {
        await interaction.reply({ content: '존재하지 않는 상품입니다.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply({
        content: `✅ ${result.potion.name} 1개를 구매했습니다. 보유 수량: **${result.quantity}개** · 남은 골드: **${result.gold}**`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('skill_catalog:')) {
      const [, ownerId, pageIndex] = interaction.customId.split(':');
      if (interaction.user.id !== ownerId) {
        await interaction.reply({
          content: '이 스킬도감은 명령어를 실행한 사용자만 넘길 수 있습니다.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const player = await playerStore.getOrCreate(ownerId);
      await interaction.update(createSkillCatalogPage(interaction.user, player, pageIndex));
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('potion:')) {
      await adventureSystem.handlePotionButton(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('skill_target:')) {
      await adventureSystem.handleSkillTargetButton(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('skill:')) {
      await adventureSystem.handleSkillButton(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('checkpoint_select:')) {
      await adventureSystem.handleCheckpointSelect(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('dungeon:')) {
      await adventureSystem.handleButton(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('pvp:')) {
      await pvpManager.handleButton(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('duel_invite:')) {
      const [, duelId, choice] = interaction.customId.split(':');
      const duel = pendingDuels.get(duelId);
      if (!duel) {
        await interaction.reply({ content: '이미 종료된 결투 신청입니다.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.user.id !== duel.opponentId) {
        await interaction.reply({ content: '결투를 신청받은 플레이어만 선택할 수 있습니다.', flags: MessageFlags.Ephemeral });
        return;
      }
      pendingDuels.delete(duelId);
      clearTimeout(duel.timeout);
      if (choice !== 'yes') {
        await interaction.update({ content: `❌ <@${duel.opponentId}>님이 결투를 거절했습니다.`, components: [] });
        return;
      }

      const guild = interaction.guild;
      const challenger = await guild.members.fetch(duel.challengerId).catch(() => null);
      const opponent = await guild.members.fetch(duel.opponentId).catch(() => null);
      if (
        !challenger || !opponent || challenger.voice.channelId !== duel.voiceChannelId ||
        opponent.voice.channelId !== duel.voiceChannelId
      ) {
        await interaction.update({ content: '❌ 두 플레이어가 같은 음성 채널에 있지 않아 결투가 취소됐습니다.', components: [] });
        return;
      }
      if (
        adventureManager.getByUser(challenger.id) || adventureManager.getByUser(opponent.id) ||
        pendingInvitationByUser.has(challenger.id) || pendingInvitationByUser.has(opponent.id) ||
        pvpManager.getByUser(challenger.id) || pvpManager.getByUser(opponent.id)
      ) {
        await interaction.update({ content: '❌ 두 플레이어 중 한 명이 이미 다른 콘텐츠를 진행 중입니다.', components: [] });
        return;
      }
      await interaction.update({ content: `✅ <@${duel.opponentId}>님이 결투를 수락했습니다. 콜로세움을 준비합니다.`, components: [] });
      const result = await pvpManager.start(guild, challenger, opponent, playerStore);
      if (!result.ok) {
        await interaction.followUp({ content: '콜로세움을 만들 수 없습니다. 봇의 채널 관리 및 멤버 이동 권한을 확인해 주세요.', flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('adventure_join:')) {
      const [, invitationId, choice] = interaction.customId.split(':');
      const invitation = pendingInvitations.get(invitationId);
      if (!invitation || invitation.closing) {
        await interaction.reply({
          content: '이미 종료된 공대 모집입니다.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!invitation.invitedIds.includes(interaction.user.id)) {
        await interaction.reply({
          content: '이 모집의 초대 대상이 아닙니다.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (
        invitation.acceptedIds.has(interaction.user.id) ||
        invitation.declinedIds.has(interaction.user.id)
      ) {
        await interaction.reply({
          content: '이미 응답했습니다.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (choice === 'yes') invitation.acceptedIds.add(interaction.user.id);
      else invitation.declinedIds.add(interaction.user.id);
      await interaction.reply({
        content: choice === 'yes' ? '✅ 모험 동행에 동의했습니다.' : '❌ 모험 동행을 거절했습니다.',
        flags: MessageFlags.Ephemeral,
      });
      await invitation.message
        .edit({
          content: invitationText(invitation),
          components: [createChoiceButtons('adventure_join', invitation.id, '동행하기', '거절하기')],
        })
        .catch(() => {});

      const responseCount = invitation.acceptedIds.size + invitation.declinedIds.size;
      if (responseCount === invitation.invitedIds.length) await finishInvitation(invitation.id);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('adventure_stop:')) {
      const [, adventureId, choice] = interaction.customId.split(':');
      const vote = stopVotes.get(adventureId);
      const adventure = adventureManager.adventures.get(adventureId);
      if (!vote || !adventure) {
        await interaction.reply({
          content: '이미 종료된 투표입니다.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const battle = adventureSystem.battles.get(adventureId);
      if (battle && !canStopDuringBattle(battle)) {
        await closeStopVote(vote, '⚔️ 파티의 공격과 피격이 모두 발생해 모험 중지 투표를 취소했습니다. 전투 종료 후 다시 요청해 주세요.');
        await interaction.reply({
          content: '파티의 공격과 피격이 모두 발생한 전투 중에는 모험 중지 투표를 진행할 수 없습니다.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!vote.memberIds.includes(interaction.user.id)) {
        await interaction.reply({
          content: '현재 파티원만 투표할 수 있습니다.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (vote.yesIds.has(interaction.user.id) || vote.noIds.has(interaction.user.id)) {
        await interaction.reply({
          content: '이미 투표했습니다.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (choice === 'yes') vote.yesIds.add(interaction.user.id);
      else vote.noIds.add(interaction.user.id);
      await interaction.reply({
        content: choice === 'yes' ? '✅ 모험 중지에 찬성했습니다.' : '❌ 모험 중지에 반대했습니다.',
        flags: MessageFlags.Ephemeral,
      });

      const threshold = Math.floor(vote.memberIds.length / 2) + 1;
      if (vote.yesIds.size >= threshold) {
        await closeStopVote(vote, `🛑 찬성 ${vote.yesIds.size}표로 과반수를 넘어 모험을 종료합니다.`);
        adventureSystem.cleanup(adventureId);
        await adventureManager.end(client, adventureId, 'PARTY_STOP_VOTE_PASSED');
        return;
      }

      if (vote.yesIds.size + vote.noIds.size === vote.memberIds.length) {
        await closeStopVote(vote, '❌ 과반수 찬성을 얻지 못해 모험 중지 투표가 부결됐습니다.');
        return;
      }

      await vote.message.edit({ content: stopVoteText(vote) }).catch(() => {});
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('rps:')) {
      const playerKey = interaction.customId.split(':')[1];
      const botKeys = Object.keys(choices);
      const botKey = botKeys[Math.floor(Math.random() * botKeys.length)];
      const playerChoice = choices[playerKey];
      const botChoice = choices[botKey];

      let result = '무승부입니다!';
      if (playerChoice.beats === botKey) result = '당신이 이겼습니다! 🎉';
      if (botChoice.beats === playerKey) result = '봇이 이겼습니다! 🤖';

      await interaction.update({
        content: [
          `당신: ${playerChoice.emoji} ${playerChoice.label}`,
          `봇: ${botChoice.emoji} ${botChoice.label}`,
          `**${result}**`,
        ].join('\n'),
        components: [],
      });
    }
  } catch (error) {
    console.error('상호작용 처리 중 오류가 발생했습니다.', error);

    if (interaction.isAutocomplete()) {
      await interaction.respond([]).catch(() => {});
      return;
    }

    const message = { content: '명령을 처리하는 중 오류가 발생했습니다.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(message).catch(() => {});
    } else {
      await interaction.reply(message).catch(() => {});
    }
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    await adventureManager.handleVoiceStateUpdate(client, oldState, newState);
    await pvpManager.handleVoiceStateUpdate(client, oldState, newState);
  } catch (error) {
    console.error('음성 채널 이탈 처리 중 오류가 발생했습니다.', error);
  }
});

client.login(process.env.DISCORD_TOKEN);
