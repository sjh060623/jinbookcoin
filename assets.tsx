import { BlurView } from 'expo-blur';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

export type ClosedPosition = {
  id: string;
  side: 'LONG' | 'SHORT';
  sizeUsd: number;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  realizedPnl: number;
  closedAt: string;
};

export type OpenPosition = {
  id: string;
  side: 'LONG' | 'SHORT';
  sizeUsd: number;
  qty: number;
  entryPrice: number;
  leverage: number;
  margin: number;
};

type AssetsScreenProps = {
  balance: number;
  dayPnl: number;
  history: ClosedPosition[];
  currentPrice: number;
  positions: OpenPosition[];
  onResetBalance: () => void;
};

const currency = (value: number) => `$${value.toFixed(2)}`;

const signedCurrency = (value: number) => {
  if (value > 0) {
    return `+${currency(value)}`;
  }
  return currency(value);
};

const pnlForPosition = (position: OpenPosition, price: number) => {
  const direction = position.side === 'LONG' ? 1 : -1;
  return direction * (price - position.entryPrice) * position.qty;
};

const roiForPosition = (position: OpenPosition, price: number) => {
  if (position.margin <= 0) {
    return 0;
  }
  return (pnlForPosition(position, price) / position.margin) * 100;
};

export default function AssetsScreen({
  balance,
  dayPnl,
  history,
  currentPrice,
  positions,
  onResetBalance,
}: AssetsScreenProps) {
  return (
    <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
      <BlurView intensity={20} tint="dark" style={styles.assetCard}>
        <Text style={styles.cardTitle}>Assets</Text>
        <View style={styles.assetLine}>
          <Text style={styles.assetLabel}>BTC Price</Text>
          <Text style={styles.assetValue}>{currentPrice > 0 ? currency(currentPrice) : '-'}</Text>
        </View>
        <View style={styles.assetLine}>
          <Text style={styles.assetLabel}>Balance</Text>
          <Text style={styles.assetValue}>{currency(balance)}</Text>
        </View>
        <View style={styles.assetLine}>
          <Text style={styles.assetLabel}>Today PnL</Text>
          <Text style={[styles.assetValue, dayPnl >= 0 ? styles.up : styles.down]}>
            {signedCurrency(dayPnl)}
          </Text>
        </View>
        <View style={styles.assetLine}>
          <Text style={styles.assetLabel}>Closed Trades</Text>
          <Text style={styles.assetValue}>{history.length}</Text>
        </View>
      </BlurView>

      <BlurView intensity={20} tint="dark" style={styles.assetCard}>
        <Text style={styles.cardTitle}>Open Position Snapshot</Text>
        {positions.length === 0 ? (
          <Text style={styles.emptyText}>No open positions.</Text>
        ) : (
          positions.map((position) => {
            const pnl = pnlForPosition(position, currentPrice);
            const roi = roiForPosition(position, currentPrice);
            return (
              <View key={position.id} style={styles.historyItem}>
                <View style={styles.rowBetween}>
                  <Text style={styles.historyTitle}>
                    {position.side} {currency(position.sizeUsd)}
                  </Text>
                  <Text style={[styles.historyPnl, pnl >= 0 ? styles.up : styles.down]}>
                    {signedCurrency(pnl)}
                  </Text>
                </View>
                <Text style={styles.positionMeta}>
                  ROI {roi >= 0 ? '+' : ''}{roi.toFixed(2)}% | Entry {currency(position.entryPrice)} | Qty{' '}
                  {position.qty.toFixed(4)} BTC
                </Text>
              </View>
            );
          })
        )}
      </BlurView>

      <BlurView intensity={20} tint="dark" style={styles.assetCard}>
        <Text style={styles.cardTitle}>Trade History</Text>
        {history.length === 0 ? (
          <Text style={styles.emptyText}>No closed history.</Text>
        ) : (
          history.map((trade) => (
            <View key={`${trade.id}-${trade.closedAt}`} style={styles.historyItem}>
              <View style={styles.rowBetween}>
                <Text style={styles.historyTitle}>
                  {trade.side} {currency(trade.sizeUsd)}
                </Text>
                <Text style={[styles.historyPnl, trade.realizedPnl >= 0 ? styles.up : styles.down]}>
                  {signedCurrency(trade.realizedPnl)}
                </Text>
              </View>
              <Text style={styles.positionMeta}>
                {currency(trade.entryPrice)} {'->'} {currency(trade.exitPrice)} | Qty {trade.qty.toFixed(4)} BTC |{' '}
                {new Date(trade.closedAt).toLocaleString()}
              </Text>
            </View>
          ))
        )}
      </BlurView>

      <View style={styles.resetWrap}>
        <Text style={styles.resetCaption}>Reset your demo balance anytime.</Text>
        <View style={styles.resetButtonOuter}>
          <Text style={styles.resetButton} onPress={onResetBalance}>
            Reset Money
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingTop: 38,
    paddingBottom: 98,
    gap: 14,
  },
  assetCard: {
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 10,
    backgroundColor: 'rgba(18,23,30,0.82)',
    overflow: 'hidden',
  },
  cardTitle: {
    color: '#EFF5FF',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 7,
  },
  assetLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.12)',
  },
  assetLabel: {
    color: '#9BA7BE',
    fontSize: 11,
  },
  assetValue: {
    color: '#EAF1FF',
    fontSize: 12,
    fontWeight: '700',
  },
  historyItem: {
    borderRadius: 9,
    backgroundColor: '#141B28',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 9,
    marginBottom: 8,
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  historyTitle: {
    color: '#EAF1FF',
    fontSize: 12,
    fontWeight: '700',
  },
  historyPnl: {
    fontSize: 11,
    fontWeight: '800',
  },
  positionMeta: {
    marginTop: 6,
    color: '#98A5BD',
    fontSize: 10,
  },
  emptyText: {
    color: '#8D98AA',
    fontSize: 11,
  },
  resetWrap: {
    marginTop: 2,
    marginBottom: 8,
  },
  resetCaption: {
    color: '#8D98AA',
    fontSize: 11,
    marginBottom: 8,
    textAlign: 'center',
  },
  resetButtonOuter: {
    borderRadius: 11,
    overflow: 'hidden',
    backgroundColor: '#2A3242',
  },
  resetButton: {
    color: '#F8FBFF',
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
    paddingVertical: 12,
  },
  up: {
    color: '#02C076',
  },
  down: {
    color: '#F6465D',
  },
});
