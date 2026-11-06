# 무료 서버 배포 준비

현재는 모의매매 서버 시제품이며 실거래 API 키를 사용하지 않습니다.

Linux VM에 Docker Compose 설치 후 `cd server && docker compose up -d --build`를 실행합니다.
서버 상태: `curl http://127.0.0.1:8000/health`
거래 기록: `curl http://127.0.0.1:8000/portfolio`

데이터는 Docker 볼륨에 저장됩니다. 외부 모바일 접속에는 HTTPS와 인증이 추가로 필요합니다. 무료 서버는 중단될 수 있습니다. 승률 및 실현손익 계산, 수수료, 백테스트, 호가벽 분석은 아직 미구현입니다.
