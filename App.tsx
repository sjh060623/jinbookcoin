import AsyncStorage from '@react-native-async-storage/async-storage';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { SafeAreaView } from 'react-native-safe-area-context';
import AssetsScreen, { OpenPosition } from './assets';

type Side = 'LONG' | 'SHORT';
type Tab = 'TRADE' | 'ASSETS';
type WsStatus = 'CONNECTING' | 'LIVE' | 'OFFLINE';

type Position = {
  id: string;
  side: Side;
  sizeUsd: number;
  qty: number;
  entryPrice: number;
  leverage: number;
  margin: number;
  openedAt: string;
};

type ClosedPosition = Position & {
  exitPrice: number;
  feePaid: number;
  realizedPnl: number;
  closedAt: string;
};

type PersistedState = {
  balance: number;
  positions: Position[];
  history: ClosedPosition[];
};

type BookLevel = {
  price: number;
  qty: number;
};

const STORAGE_KEY = 'jinbookcoin_state_v1';
const DEFAULT_BALANCE = 1000;
const DEFAULT_SYMBOL = 'BTCUSDT';

const currency = (value: number) => `$${value.toFixed(2)}`;

const signedCurrency = (value: number) => {
  if (value > 0) {
    return `+${currency(value)}`;
  }
  return currency(value);
};

const pnlForPosition = (position: Position, price: number) => {
  const direction = position.side === 'LONG' ? 1 : -1;
  return direction * (price - position.entryPrice) * position.qty;
};

const parseJson = (raw: unknown) => {
  if (typeof raw === 'string') {
    return JSON.parse(raw);
  }
  return JSON.parse(String(raw));
};

const parseBookLevels = (rows: unknown): BookLevel[] => {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) {
        return null;
      }
      const price = Number(entry[0]);
      const qty = Number(entry[1]);
      if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty <= 0) {
        return null;
      }
      return { price, qty };
    })
    .filter((entry): entry is BookLevel => entry !== null);
};

export default function App() {
  const [tab, setTab] = useState<Tab>('TRADE');
  const [sizeUsd, setSizeUsd] = useState(100);
  const [leverage, setLeverage] = useState(10);

  const [markPrice, setMarkPrice] = useState(0);
  const [bestBid, setBestBid] = useState(0);
  const [bestAsk, setBestAsk] = useState(0);
  const [bids, setBids] = useState<BookLevel[]>([]);
  const [asks, setAsks] = useState<BookLevel[]>([]);
  const [lastUpdate, setLastUpdate] = useState('');
  const [wsStatus, setWsStatus] = useState<WsStatus>('CONNECTING');

  const [balance, setBalance] = useState(DEFAULT_BALANCE);
  const [positions, setPositions] = useState<Position[]>([]);
  const [history, setHistory] = useState<ClosedPosition[]>([]);
  const [hydrated, setHydrated] = useState(false);

  const reconnectTimer = useRef<number | undefined>(undefined);

  const displayPrice = useMemo(() => {
    if (bestBid > 0 && bestAsk > 0) {
      return (bestBid + bestAsk) / 2;
    }
    if (markPrice > 0) {
      return markPrice;
    }
    return 0;
  }, [markPrice, bestBid, bestAsk]);

  const estimatedMargin = useMemo(() => {
    if (sizeUsd <= 0 || leverage <= 0 || displayPrice <= 0) {
      return 0;
    }
    return sizeUsd / leverage;
  }, [sizeUsd, leverage, displayPrice]);

  const maxSizeUsd = useMemo(() => {
    const effectiveLeverage = leverage >= 1 ? leverage : 1;
    const computed = balance * effectiveLeverage;
    return Math.max(100, Math.floor(computed));
  }, [balance, leverage]);

  const unrealizedPnl = useMemo(
    () => positions.reduce((sum, position) => sum + pnlForPosition(position, displayPrice), 0),
    [positions, displayPrice],
  );

  const dayPnl = useMemo(() => {
    const today = new Date().toDateString();
    return history
      .filter((trade) => new Date(trade.closedAt).toDateString() === today)
      .reduce((sum, trade) => sum + trade.realizedPnl, 0);
  }, [history]);

  const askRows = useMemo(() => asks.slice(0, 8).reverse(), [asks]);
  const bidRows = useMemo(() => bids.slice(0, 8), [bids]);

  useEffect(() => {
    const hydrateState = async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!raw) {
          setHydrated(true);
          return;
        }

        const parsed: PersistedState = JSON.parse(raw);
        setBalance(typeof parsed.balance === 'number' ? parsed.balance : DEFAULT_BALANCE);
        const safePositions = Array.isArray(parsed.positions)
          ? parsed.positions.map((position) => ({
              ...position,
              sizeUsd:
                typeof position.sizeUsd === 'number' && position.sizeUsd > 0
                  ? position.sizeUsd
                  : position.qty * position.entryPrice,
            }))
          : [];

        const safeHistory = Array.isArray(parsed.history)
          ? parsed.history.map((position) => ({
              ...position,
              feePaid: typeof position.feePaid === 'number' ? position.feePaid : 0,
              sizeUsd:
                typeof position.sizeUsd === 'number' && position.sizeUsd > 0
                  ? position.sizeUsd
                  : position.qty * position.entryPrice,
            }))
          : [];

        setPositions(safePositions);
        setHistory(safeHistory);
      } catch {
        Alert.alert('Restore failed', 'Could not load saved state. Starting fresh.');
      } finally {
        setHydrated(true);
      }
    };

    hydrateState();
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    const state: PersistedState = { balance, positions, history };
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => {
      Alert.alert('Save failed', 'Failed to persist app state.');
    });
  }, [balance, positions, history, hydrated]);

  useEffect(() => {
    let markSocket: WebSocket | null = null;
    let tickerSocket: WebSocket | null = null;
    let depthSocket: WebSocket | null = null;
    let disposed = false;

    const connect = () => {
      setWsStatus('CONNECTING');

      markSocket = new WebSocket('wss://fstream.binance.com/ws/btcusdt@markPrice@1s');
      tickerSocket = new WebSocket('wss://fstream.binance.com/ws/btcusdt@bookTicker');
      depthSocket = new WebSocket('wss://fstream.binance.com/ws/btcusdt@depth20@100ms');

      const markLive = () => {
        setWsStatus('LIVE');
        setLastUpdate(new Date().toISOString());
      };

      markSocket.onopen = markLive;
      tickerSocket.onopen = markLive;
      depthSocket.onopen = markLive;

      markSocket.onmessage = (event) => {
        try {
          const payload = parseJson(event.data);
          const nextPrice = Number(payload.p);
          if (Number.isFinite(nextPrice) && nextPrice > 0) {
            setMarkPrice(nextPrice);
            setLastUpdate(new Date().toISOString());
            setWsStatus('LIVE');
          }
        } catch {
          // keep stream alive when malformed frame appears
        }
      };

      tickerSocket.onmessage = (event) => {
        try {
          const payload = parseJson(event.data);
          const bid = Number(payload.b);
          const ask = Number(payload.a);
          if (Number.isFinite(bid) && bid > 0) {
            setBestBid(bid);
          }
          if (Number.isFinite(ask) && ask > 0) {
            setBestAsk(ask);
          }
          if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
            setMarkPrice((bid + ask) / 2);
          }
          setLastUpdate(new Date().toISOString());
          setWsStatus('LIVE');
        } catch {
          // keep stream alive when malformed frame appears
        }
      };

      depthSocket.onmessage = (event) => {
        try {
          const payload = parseJson(event.data);
          const nextBids = parseBookLevels(payload.b).slice(0, 12);
          const nextAsks = parseBookLevels(payload.a).slice(0, 12);
          setBids(nextBids);
          setAsks(nextAsks);
          if (nextBids.length > 0 && nextAsks.length > 0) {
            setMarkPrice((nextBids[0].price + nextAsks[0].price) / 2);
          }
          setLastUpdate(new Date().toISOString());
          setWsStatus('LIVE');
        } catch {
          // keep stream alive when malformed frame appears
        }
      };

      const handleCloseOrError = () => {
        if (disposed) {
          return;
        }
        setWsStatus('OFFLINE');
        reconnectTimer.current = setTimeout(connect, 2000) as unknown as number;
      };

      markSocket.onerror = handleCloseOrError;
      tickerSocket.onerror = handleCloseOrError;
      depthSocket.onerror = handleCloseOrError;

      markSocket.onclose = handleCloseOrError;
      tickerSocket.onclose = handleCloseOrError;
      depthSocket.onclose = handleCloseOrError;
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
      markSocket?.close();
      tickerSocket?.close();
      depthSocket?.close();
    };
  }, []);

  const openPosition = (side: Side) => {
    if (displayPrice <= 0) {
      Alert.alert('No price yet', 'Wait until live orderbook/price data arrives.');
      return;
    }

    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) {
      Alert.alert('Invalid size', 'Please choose a valid USD size.');
      return;
    }

    if (!Number.isFinite(leverage) || leverage < 1 || leverage > 125) {
      Alert.alert('Invalid leverage', 'Leverage must be between 1 and 125.');
      return;
    }

    const margin = sizeUsd / leverage;

    if (margin > balance) {
      Alert.alert('Insufficient balance', 'Required margin exceeds available balance.');
      return;
    }

    const position: Position = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      side,
      sizeUsd,
      qty: sizeUsd / displayPrice,
      entryPrice: displayPrice,
      leverage,
      margin,
      openedAt: new Date().toISOString(),
    };

    setBalance((prev) => prev - margin);
    setPositions((prev) => [position, ...prev]);
  };

  const closePosition = (id: string, feePaid: number) => {
    const target = positions.find((position) => position.id === id);
    if (!target) {
      return;
    }

    if (displayPrice <= 0) {
      Alert.alert('No price yet', 'Wait until live orderbook/price data arrives.');
      return;
    }

    const realizedPnl = pnlForPosition(target, displayPrice) - feePaid;
    const closed: ClosedPosition = {
      ...target,
      exitPrice: displayPrice,
      feePaid,
      realizedPnl,
      closedAt: new Date().toISOString(),
    };

    setPositions((prev) => prev.filter((position) => position.id !== id));
    setHistory((prev) => [closed, ...prev]);
    setBalance((prev) => prev + target.margin + realizedPnl);
  };

  const requestClosePosition = (id: string) => {
    const target = positions.find((position) => position.id === id);
    if (!target || displayPrice <= 0) {
      Alert.alert('No price yet', 'Wait until live orderbook/price data arrives.');
      return;
    }

    const grossPnl = pnlForPosition(target, displayPrice);
    const feeRate = 0.0002;
    const feeUsd = target.sizeUsd * feeRate;
    const finalPnl = grossPnl - feeUsd;
    const feePercent = feeRate * 100;

    Alert.alert(
      'Close Position Confirm',
      `Gross PnL: ${signedCurrency(grossPnl)}\nFee (${feeRate.toFixed(4)} / ${feePercent.toFixed(2)}%): ${currency(feeUsd)}\nFinal PnL: ${signedCurrency(finalPnl)}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          style: 'destructive',
          onPress: () => closePosition(id, feeUsd),
        },
      ],
    );
  };

  const resetBalance = () => {
    Alert.alert('Reset Money', 'Reset balance, positions, and history back to the default demo state?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: () => {
          setBalance(DEFAULT_BALANCE);
          setPositions([]);
          setHistory([]);
          setSizeUsd(100);
          setLeverage(10);
        },
      },
    ]);
  };

  const liqPriceForPosition = (position: Position) => {
    if (position.leverage <= 0) {
      return position.entryPrice;
    }
    if (position.side === 'LONG') {
      return position.entryPrice * (1 - 1 / position.leverage);
    }
    return position.entryPrice * (1 + 1 / position.leverage);
  };

  const wsColor = wsStatus === 'LIVE' ? '#00C087' : wsStatus === 'CONNECTING' ? '#F8C24E' : '#FF5B77';

  return (
    <LinearGradient colors={['#0B0E11', '#10141D', '#0D1118']} style={styles.root}>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />

        {tab === 'TRADE' ? (
          <>
            <View style={styles.topHeader}>
              <View>
                <Text style={styles.symbolTitle}>{DEFAULT_SYMBOL} PERP</Text>
                <Text style={styles.exchangeLabel}>Mock Futures</Text>
              </View>
              <View style={styles.rowCenter}>
                <View style={[styles.wsDot, { backgroundColor: wsColor }]} />
                <Text style={styles.wsText}>{wsStatus}</Text>
              </View>
            </View>

            <BlurView intensity={22} tint="dark" style={styles.tickerCard}>
              <View style={styles.rowBetween}>
                <Text style={styles.priceText}>{displayPrice > 0 ? currency(displayPrice) : 'Connecting...'}</Text>
                <Text style={styles.updateText}>
                  {lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : 'Waiting feed'}
                </Text>
              </View>
              <View style={styles.bookTickerRow}>
                <Text style={styles.bidText}>Bid {bestBid > 0 ? currency(bestBid) : '-'}</Text>
                <Text style={styles.askText}>Ask {bestAsk > 0 ? currency(bestAsk) : '-'}</Text>
              </View>
            </BlurView>
          </>
        ) : (
          <View style={styles.assetsTopSpacer} />
        )}

        <View style={[styles.metricRow, tab === 'ASSETS' && styles.metricRowAssets]}>
          <BlurView intensity={18} tint="dark" style={styles.metricCard}>
            <Text style={styles.metricLabel}>Available</Text>
            <Text style={styles.metricValue}>{currency(balance)}</Text>
          </BlurView>
          <BlurView intensity={18} tint="dark" style={styles.metricCard}>
            <Text style={styles.metricLabel}>Unrealized PnL</Text>
            <Text style={[styles.metricValue, unrealizedPnl >= 0 ? styles.up : styles.down]}>
              {signedCurrency(unrealizedPnl)}
            </Text>
          </BlurView>
        </View>

        {tab === 'TRADE' ? (
          <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
            <>
              <View style={styles.marketRow}>
                <BlurView intensity={18} tint="dark" style={styles.orderBookCard}>
                  <Text style={styles.cardTitle}>Order Book</Text>

                  <View style={styles.bookHeaderRow}>
                    <Text style={styles.bookHeader}>Price</Text>
                    <Text style={styles.bookHeader}>Qty</Text>
                  </View>

                  {askRows.map((level) => (
                    <View key={`ask-${level.price}`} style={styles.bookRow}>
                      <Text style={styles.askText}>{level.price.toFixed(2)}</Text>
                      <Text style={styles.bookQty}>{level.qty.toFixed(4)}</Text>
                    </View>
                  ))}

                  <View style={styles.midPriceWrap}>
                    <Text style={styles.midPrice}>{displayPrice > 0 ? currency(displayPrice) : '-'}</Text>
                  </View>

                  {bidRows.map((level) => (
                    <View key={`bid-${level.price}`} style={styles.bookRow}>
                      <Text style={styles.bidText}>{level.price.toFixed(2)}</Text>
                      <Text style={styles.bookQty}>{level.qty.toFixed(4)}</Text>
                    </View>
                  ))}
                </BlurView>

                <BlurView intensity={18} tint="dark" style={styles.tradeCard}>
                  <Text style={styles.cardTitle}>Futures Panel</Text>

                  <Text style={styles.inputLabel}>Size (USD)</Text>
                  <Text style={styles.sizeValue}>{currency(sizeUsd)}</Text>
                  <Slider
                    value={Math.min(sizeUsd, maxSizeUsd)}
                    minimumValue={10}
                    maximumValue={maxSizeUsd}
                    step={10}
                    minimumTrackTintColor="#F3BA2F"
                    maximumTrackTintColor="#394255"
                    thumbTintColor="#F3BA2F"
                    onValueChange={(next) => setSizeUsd(Math.max(10, Math.round(next)))}
                  />

                  <Text style={[styles.inputLabel, styles.inputTopGap]}>Leverage (x)</Text>
                  <Text style={styles.sizeValue}>{leverage.toFixed(0)}x</Text>
                  <Slider
                    value={leverage}
                    minimumValue={1}
                    maximumValue={125}
                    step={1}
                    minimumTrackTintColor="#F3BA2F"
                    maximumTrackTintColor="#394255"
                    thumbTintColor="#F3BA2F"
                    onValueChange={(next) => setLeverage(Math.max(1, Math.round(next)))}
                  />

                  <Text style={styles.estimate}>Est. Margin: {currency(estimatedMargin)}</Text>

                  <Pressable style={styles.longButton} onPress={() => openPosition('LONG')}>
                    <Text style={styles.actionButtonText}>Open Long</Text>
                  </Pressable>
                  <Pressable style={styles.shortButton} onPress={() => openPosition('SHORT')}>
                    <Text style={styles.actionButtonText}>Open Short</Text>
                  </Pressable>
                </BlurView>
              </View>

              <BlurView intensity={20} tint="dark" style={styles.positionsCard}>
                <View style={styles.positionsHeader}>
                  <View>
                    <Text style={styles.cardTitle}>Open Positions</Text>
                    <Text style={styles.positionsSubTitle}>Live PnL and liquidation snapshot</Text>
                  </View>
                  <View style={styles.positionCountChip}>
                    <Text style={styles.positionCountChipText}>{positions.length}</Text>
                  </View>
                </View>
                {positions.length === 0 ? (
                  <Text style={styles.emptyText}>No open position.</Text>
                ) : (
                  positions.map((position) => {
                    const pnl = pnlForPosition(position, displayPrice);
                    const roi = position.margin > 0 ? (pnl / position.margin) * 100 : 0;
                    const liqPrice = liqPriceForPosition(position);
                    return (
                      <View
                        key={position.id}
                        style={[
                          styles.positionItem,
                          position.side === 'LONG' ? styles.positionItemLong : styles.positionItemShort,
                        ]}
                      >
                        <View style={styles.positionItemTopRow}>
                          <View style={styles.positionSideWrap}>
                            <View
                              style={[
                                styles.positionSideDot,
                                position.side === 'LONG' ? styles.upBackground : styles.downBackground,
                              ]}
                            />
                            <View>
                              <Text
                                style={[
                                  styles.positionSide,
                                  position.side === 'LONG' ? styles.up : styles.down,
                                ]}
                              >
                                {position.side}
                              </Text>
                              <Text style={styles.positionSizeText}>{currency(position.sizeUsd)}</Text>
                            </View>
                          </View>
                          <View style={styles.positionPnlBox}>
                            <Text style={styles.positionStatLabel}>PnL</Text>
                            <Text style={[styles.positionPnl, pnl >= 0 ? styles.up : styles.down]}>
                              {signedCurrency(pnl)}
                            </Text>
                          </View>
                        </View>

                        <View style={styles.positionMetricGrid}>
                          <View style={styles.positionMetricCell}>
                            <Text style={styles.positionStatLabel}>ROI</Text>
                            <Text style={[styles.positionMetricValue, roi >= 0 ? styles.up : styles.down]}>
                              {roi >= 0 ? '+' : ''}{roi.toFixed(2)}%
                            </Text>
                          </View>
                          <View style={styles.positionMetricCell}>
                            <Text style={styles.positionStatLabel}>Leverage</Text>
                            <Text style={styles.positionMetricValue}>{position.leverage.toFixed(1)}x</Text>
                          </View>
                          <View style={styles.positionMetricCell}>
                            <Text style={styles.positionStatLabel}>Margin</Text>
                            <Text style={styles.positionMetricValue}>{currency(position.margin)}</Text>
                          </View>
                          <View style={styles.positionMetricCell}>
                            <Text style={styles.positionStatLabel}>Qty</Text>
                            <Text style={styles.positionMetricValue}>{position.qty.toFixed(4)}</Text>
                          </View>
                        </View>

                        <View style={styles.positionMetaRow}>
                          <Text style={styles.positionMeta}>Entry {currency(position.entryPrice)}</Text>
                          <Text style={styles.positionMeta}>Liq {currency(liqPrice)}</Text>
                        </View>
                        <Pressable style={styles.closeButton} onPress={() => requestClosePosition(position.id)}>
                          <Text style={styles.closeButtonText}>Close</Text>
                        </Pressable>
                      </View>
                    );
                  })
                )}
              </BlurView>
            </>
          </ScrollView>
        ) : (
          <AssetsScreen
            balance={balance}
            dayPnl={dayPnl}
            history={history}
            currentPrice={displayPrice}
            positions={positions as OpenPosition[]}
            onResetBalance={resetBalance}
          />
        )}

        <View style={styles.bottomNav}>
          <Pressable
            style={[styles.bottomNavButton, tab === 'TRADE' && styles.bottomNavButtonActive]}
            onPress={() => setTab('TRADE')}
          >
            <Text style={[styles.bottomNavText, tab === 'TRADE' && styles.bottomNavTextActive]}>Trade</Text>
          </Pressable>
          <Pressable
            style={[styles.bottomNavButton, tab === 'ASSETS' && styles.bottomNavButtonActive]}
            onPress={() => setTab('ASSETS')}
          >
            <Text style={[styles.bottomNavText, tab === 'ASSETS' && styles.bottomNavTextActive]}>Assets</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  topHeader: {
    marginTop: 18,
    marginBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  symbolTitle: {
    color: '#F6FAFF',
    fontSize: 20,
    fontWeight: '800',
  },
  exchangeLabel: {
    color: '#8D98AA',
    fontSize: 12,
    marginTop: 2,
  },
  rowCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  wsDot: {
    width: 8,
    height: 8,
    borderRadius: 8,
  },
  wsText: {
    color: '#D0D8E6',
    fontSize: 11,
    fontWeight: '700',
  },
  tickerCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: 'rgba(18,23,30,0.82)',
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  priceText: {
    color: '#F8FBFF',
    fontSize: 20,
    fontWeight: '800',
  },
  updateText: {
    color: '#919CB0',
    fontSize: 11,
  },
  bookTickerRow: {
    marginTop: 4,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  assetsTopSpacer: {
    height: 28,
  },
  bidText: {
    color: '#02C076',
    fontSize: 12,
    fontWeight: '700',
  },
  askText: {
    color: '#F6465D',
    fontSize: 12,
    fontWeight: '700',
  },
  metricRow: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 12,
  },
  metricRowAssets: {
    paddingTop: 12,
  },
  metricCard: {
    flex: 1,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
    padding: 9,
    backgroundColor: 'rgba(18,23,30,0.72)',
  },
  metricLabel: {
    color: '#9AA6BC',
    fontSize: 10,
  },
  metricValue: {
    marginTop: 4,
    color: '#F4F8FF',
    fontSize: 14,
    fontWeight: '700',
  },
  scrollContent: {
    paddingTop: 38,
    paddingBottom: 98,
    gap: 14,
  },
  marketRow: {
    flexDirection: 'row',
    gap: 12,
  },
  orderBookCard: {
    flex: 1.2,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 9,
    backgroundColor: 'rgba(18,23,30,0.82)',
    overflow: 'hidden',
  },
  tradeCard: {
    flex: 1,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 9,
    backgroundColor: 'rgba(18,23,30,0.82)',
    overflow: 'hidden',
  },
  cardTitle: {
    color: '#EFF5FF',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 7,
  },
  bookHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  bookHeader: {
    color: '#7F8CA3',
    fontSize: 10,
    fontWeight: '600',
  },
  bookRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 2,
  },
  bookQty: {
    color: '#BAC6D9',
    fontSize: 11,
    fontWeight: '600',
  },
  midPriceWrap: {
    marginVertical: 8,
    paddingVertical: 5,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  midPrice: {
    color: '#F6FAFF',
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
  },
  inputLabel: {
    color: '#8E99AF',
    fontSize: 10,
    marginBottom: 5,
  },
  sizeValue: {
    color: '#F3BA2F',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 2,
  },
  inputTopGap: {
    marginTop: 8,
  },
  input: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: '#111722',
    color: '#EAF1FF',
    paddingHorizontal: 9,
    paddingVertical: 8,
    fontSize: 13,
    fontWeight: '600',
  },
  estimate: {
    marginTop: 9,
    color: '#A1ADC2',
    fontSize: 11,
  },
  longButton: {
    marginTop: 10,
    borderRadius: 9,
    backgroundColor: '#01A66B',
    paddingVertical: 10,
    alignItems: 'center',
  },
  shortButton: {
    marginTop: 8,
    borderRadius: 9,
    backgroundColor: '#E1435A',
    paddingVertical: 10,
    alignItems: 'center',
  },
  actionButtonText: {
    color: '#F8FBFF',
    fontWeight: '800',
    fontSize: 12,
  },
  positionsCard: {
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 12,
    backgroundColor: 'rgba(18,23,30,0.82)',
    overflow: 'hidden',
  },
  positionsHeader: {
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  positionsSubTitle: {
    marginTop: 2,
    color: '#8D98AA',
    fontSize: 10,
  },
  positionCountChip: {
    minWidth: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(243,186,47,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(243,186,47,0.24)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  positionCountChipText: {
    color: '#F3BA2F',
    fontSize: 12,
    fontWeight: '800',
  },
  positionItem: {
    marginBottom: 10,
    borderRadius: 14,
    backgroundColor: '#121A27',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    padding: 12,
    borderLeftWidth: 4,
  },
  positionItemLong: {
    borderLeftColor: '#02C076',
  },
  positionItemShort: {
    borderLeftColor: '#F6465D',
  },
  positionItemTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  positionSideWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  positionSideDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 3,
  },
  positionSide: {
    fontSize: 13,
    fontWeight: '800',
  },
  positionSizeText: {
    marginTop: 2,
    color: '#DCE4F1',
    fontSize: 12,
    fontWeight: '700',
  },
  positionPnlBox: {
    alignItems: 'flex-end',
  },
  positionPnl: {
    fontSize: 15,
    fontWeight: '800',
  },
  positionStatLabel: {
    color: '#8FA0BA',
    fontSize: 11,
    fontWeight: '700',
  },
  positionMetricGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  positionMetricCell: {
    width: '48%',
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  positionMetricValue: {
    marginTop: 4,
    color: '#F4F8FF',
    fontSize: 13,
    fontWeight: '800',
  },
  positionMetaRow: {
    marginTop: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  positionMeta: {
    color: '#98A5BD',
    fontSize: 11,
  },
  closeButton: {
    marginTop: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(243,186,47,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(243,186,47,0.22)',
    paddingVertical: 8,
    alignItems: 'center',
  },
  closeButtonText: {
    color: '#F3BA2F',
    fontSize: 11,
    fontWeight: '800',
  },
  upBackground: {
    backgroundColor: '#02C076',
  },
  downBackground: {
    backgroundColor: '#F6465D',
  },
  bottomNav: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 12,
    marginTop: 12,
    flexDirection: 'row',
    backgroundColor: '#151A23',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 11,
    padding: 4,
  },
  bottomNavButton: {
    flex: 1,
    borderRadius: 7,
    paddingVertical: 9,
    alignItems: 'center',
  },
  bottomNavButtonActive: {
    backgroundColor: '#293244',
  },
  bottomNavText: {
    color: '#8E99AF',
    fontWeight: '700',
    fontSize: 12,
  },
  bottomNavTextActive: {
    color: '#F3F7FF',
  },
  emptyText: {
    color: '#8D98AA',
    fontSize: 11,
  },
  up: {
    color: '#02C076',
  },
  down: {
    color: '#F6465D',
  },
});
