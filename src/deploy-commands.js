import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';

const requiredVariables = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID'];
const missingVariables = requiredVariables.filter((name) => !process.env[name]);

if (missingVariables.length > 0) {
  console.error(`.env에 다음 값을 입력해 주세요: ${missingVariables.join(', ')}`);
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

try {
  console.log('슬래시 명령어를 테스트 서버에 등록하는 중...');

  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands },
  );

  console.log('슬래시 명령어 등록을 완료했습니다.');
} catch (error) {
  console.error('슬래시 명령어 등록에 실패했습니다.', error);
  process.exit(1);
}

