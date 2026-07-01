# jinbookcoin

Expo + React Native 기반 iOS 모의 코인선물 투자 앱입니다.

## 구현된 핵심 기능

- iOS 다크 모드 UI (`userInterfaceStyle: dark`)
- Liquid Glass 스타일 카드/탭 디자인 (`expo-blur`, `expo-linear-gradient`)
- Binance Perpetual Mark Price 실시간 웹소켓 수신
  - 스트림: `wss://fstream.binance.com/ws/btcusdt@markPrice`
- 복수 포지션 동시 진입
  - LONG/SHORT 선택
  - 수량/레버리지(1~125) 입력
- 포지션 청산 및 실시간 미실현/실현 PnL 반영
- 앱 재실행 후 상태 유지
  - 잔고, 오픈 포지션, 청산 히스토리 저장 (AsyncStorage)
- Assets 탭
  - 현재 잔고
  - 오늘 PnL
  - 포지션 기록(청산 히스토리)

## 실행 방법

```bash
npm install
npm run start
```

## iOS 실행

```bash
npm run ios
```

## 타입체크

```bash
npm run tsc
```
