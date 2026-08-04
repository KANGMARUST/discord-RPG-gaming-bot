import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';

const requiredVariables = ['DISCORD_TOKEN', 'CLIENT_ID'];
const missingVariables = requiredVariables.filter((name) => !process.env[name]);

if (missingVariables.length > 0) {
  console.error(`.env에 다음 값을 입력해 주세요: ${missingVariables.join(', ')}`);
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
const globalCommands = commands.filter((command) => command.name !== '디버그');

try {
  console.log('슬래시 명령어를 모든 서버에 전역 등록하는 중...');

  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    { body: globalCommands },
  );

  console.log('전역 슬래시 명령어 등록을 완료했습니다.');
} catch (error) {
  console.error('슬래시 명령어 등록에 실패했습니다.', error);
  process.exit(1);
}
