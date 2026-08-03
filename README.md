# Discord 게임 봇

JavaScript와 discord.js로 만든 기초 Discord 게임 봇입니다.

## 준비

Node.js LTS를 설치한 뒤 새 PowerShell을 열고 다음 명령을 실행합니다.

```powershell
npm install discord.js dotenv
Copy-Item .env.example .env
```

`.env`를 열어 `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`를 입력합니다. 봇 토큰은 누구에게도 공유하거나 Git에 올리지 마세요.

서버 ID를 복사하려면 Discord의 **사용자 설정 → 고급 → 개발자 모드**를 켠 뒤 서버 아이콘을 우클릭합니다.

## 실행

슬래시 명령어를 테스트 서버에 한 번 등록합니다.

```powershell
npm run deploy
```

이후 봇을 실행합니다.

```powershell
npm start
```

Discord에서 `/ping` 또는 `/게임시작`을 사용해 보세요.
