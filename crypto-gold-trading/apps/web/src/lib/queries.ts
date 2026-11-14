import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AssetId, Timeframe, TradeSetup, InstrumentSpec, JournalTrade, MonitoredSetup } from "@terminal/core";
import { api, qs, type WarmupStatus, type MonitorResponse, type BacktestRequest, type BacktestResponse, type GoldVerification, type GoldInstruments, type DxyResponse, type AnalysisResponse, type CalendarResponse, type CandlesResponse, type CircuitResponse, type CryptoRegimeResponse, type FeatureFlags, type FundingInfo, type GateRequest, type GateResponse, type GoldRegimeResponse, type IntelResponse, type JournalFilterParams, type JournalResponse, type LiquidationsSummary, type MacroResponse, type Narrative, type NewsResponse, type OpenInterestInfo, type OverviewResponse, type SetupDetailResponse, type SetupsResponse, type SizeRequest, type SizeResponse, type StatsResponse, type UserSettings, type AlertRule, type TriggeredAlert } from "./api";

export const useFeatures = () => useQuery({ queryKey: ["features"], queryFn: () => api.get<FeatureFlags>("/api/features"), staleTime: 5 * 60_000 });
export const useOverview = () => useQuery({ queryKey: ["overview"], queryFn: () => api.get<OverviewResponse>("/api/overview"), refetchInterval: (q) => (q.state.data?.warming ? 5_000 : 60_000), staleTime: 30_000 });
export const useCandles = (assetId: AssetId, tf: Timeframe, limit = 500) => useQuery({ queryKey: ["candles", assetId, tf, limit], queryFn: () => api.get<CandlesResponse>(`/api/market/candles/${assetId}${qs({ tf, limit })}`), refetchInterval: tf === "5m" ? 30_000 : tf === "15m" ? 60_000 : 120_000, staleTime: 15_000 });
export const useAnalysis = (assetId: AssetId, tfs?: Timeframe[]) => useQuery({ queryKey: ["analysis", assetId, tfs?.join(",")], queryFn: () => api.get<AnalysisResponse>(`/api/analysis/${assetId}${qs({ tfs: tfs?.join(",") })}`), refetchInterval: 60_000, staleTime: 30_000 });
export const useCryptoRegime = () => useQuery({ queryKey: ["regime", "crypto"], queryFn: () => api.get<CryptoRegimeResponse>("/api/regime/crypto"), staleTime: 5 * 60_000, refetchInterval: 10 * 60_000 });
export const useGoldRegime = () => useQuery({ queryKey: ["regime", "gold"], queryFn: () => api.get<GoldRegimeResponse>("/api/regime/gold"), staleTime: 5 * 60_000, refetchInterval: 10 * 60_000 });
export const useSetups = (assets: AssetId[], tf: Timeframe, balance?: number, risk?: number) => useQuery({ queryKey: ["setups", assets.join(","), tf, balance, risk], queryFn: () => api.get<SetupsResponse>(`/api/setups${qs({ assets: assets.join(","), tf, balance, risk })}`), enabled: assets.length > 0, refetchInterval: (q) => (q.state.data?.warming?.length ? 8_000 : 60_000), staleTime: 30_000 });
export const useSetupDetail = (assetId: AssetId | null, tf: Timeframe, balance?: number, risk?: number) => useQuery({ queryKey: ["setup", assetId, tf, balance, risk], queryFn: () => api.get<SetupDetailResponse>(`/api/setups/${assetId}${qs({ tf, balance, risk })}`), enabled: !!assetId, staleTime: 30_000 });
export const useCalendar = (params: { from?: string; to?: string; markets?: string; importance?: string }) => useQuery({ queryKey: ["calendar", params], queryFn: () => api.get<CalendarResponse>(`/api/calendar${qs(params)}`), staleTime: 10 * 60_000 });
export const useNews = (topic: "all" | "crypto" | "gold" | "macro", limit = 60) => useQuery({ queryKey: ["news", topic, limit], queryFn: () => api.get<NewsResponse>(`/api/news${qs({ topic, limit })}`), staleTime: 5 * 60_000, refetchInterval: 10 * 60_000 });
export const useIntel = () => useQuery({ queryKey: ["intel"], queryFn: () => api.get<IntelResponse>("/api/intel"), staleTime: 60_000, refetchInterval: (q) => (q.state.data?.warming ? 10_000 : 2 * 60_000) });
export const useMacro = () => useQuery({ queryKey: ["macro"], queryFn: () => api.get<MacroResponse>("/api/market/macro"), staleTime: 30 * 60_000 });
export const useFunding = (assets?: string[]) => useQuery({ queryKey: ["funding", assets?.join(",") ?? "majors"], queryFn: () => api.get<{ funding: FundingInfo[]; error?: string }>(`/api/market/funding${qs({ assets: assets?.join(",") })}`), staleTime: 60_000, refetchInterval: 60_000 });
export const useOpenInterest = (assetId: AssetId) => useQuery({ queryKey: ["oi", assetId], queryFn: () => api.get<OpenInterestInfo | { error: string }>(`/api/market/open-interest/${assetId}`), staleTime: 60_000, enabled: assetId !== "XAUUSD" });
export const useLiquidations = () => useQuery({ queryKey: ["liquidations"], queryFn: () => api.get<LiquidationsSummary>("/api/market/liquidations"), refetchInterval: 30_000 });
export const useInstruments = () => useQuery({ queryKey: ["instruments"], queryFn: () => api.get<{ instruments: InstrumentSpec[] }>("/api/risk/instruments"), staleTime: 60 * 60_000 });
export const useCircuitBreaker = () => useQuery({ queryKey: ["circuit"], queryFn: () => api.get<CircuitResponse>("/api/risk/circuit-breaker"), staleTime: 30_000 });
export const useSizeMutation = () => useMutation({ mutationFn: (body: SizeRequest) => api.post<SizeResponse>("/api/risk/size", body) });
export const useGateMutation = () => useMutation({ mutationFn: (body: GateRequest) => api.post<GateResponse>("/api/risk/gate", body) });

export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ settings: UserSettings }>("/api/user/settings"), staleTime: 60_000 });
export const useUpdateSettings = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (patch: Partial<UserSettings>) => api.put<{ settings: UserSettings }>("/api/user/settings", patch), onSuccess: () => void qc.invalidateQueries({ queryKey: ["settings"] }) });
};
export const useWatchlist = () => useQuery({ queryKey: ["watchlist"], queryFn: () => api.get<{ watchlist: AssetId[]; favorites: AssetId[] }>("/api/user/watchlist"), staleTime: 60_000 });
export const useUpdateWatchlist = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: { watchlist?: AssetId[]; favorites?: AssetId[] }) => api.put<{ watchlist: AssetId[]; favorites: AssetId[] }>("/api/user/watchlist", body), onSuccess: () => void qc.invalidateQueries({ queryKey: ["watchlist"] }) });
};
export const useAlerts = () => useQuery({ queryKey: ["alerts"], queryFn: () => api.get<{ alerts: AlertRule[]; triggered: TriggeredAlert[] }>("/api/user/alerts"), refetchInterval: 30_000 });
export const useAlertMutations = () => {
  const qc = useQueryClient();
  const inv = () => void qc.invalidateQueries({ queryKey: ["alerts"] });
  return {
    create: useMutation({ mutationFn: (body: Partial<AlertRule>) => api.post<{ alert: AlertRule }>("/api/user/alerts", body), onSuccess: inv }),
    toggle: useMutation({ mutationFn: ({ id, active }: { id: string; active: boolean }) => api.patch(`/api/user/alerts/${id}`, { active }), onSuccess: inv }),
    remove: useMutation({ mutationFn: (id: string) => api.del(`/api/user/alerts/${id}`), onSuccess: inv }),
    markRead: useMutation({ mutationFn: () => api.post("/api/user/alerts/triggered/read"), onSuccess: inv }),
  };
};
export const useSavedSetups = () => useQuery({ queryKey: ["savedSetups"], queryFn: () => api.get<{ setups: TradeSetup[] }>("/api/user/saved-setups") });
export const useSavedSetupMutations = () => {
  const qc = useQueryClient();
  const inv = () => void qc.invalidateQueries({ queryKey: ["savedSetups"] });
  return { save: useMutation({ mutationFn: (s: TradeSetup) => api.post("/api/user/saved-setups", s), onSuccess: inv }), remove: useMutation({ mutationFn: (id: string) => api.del(`/api/user/saved-setups/${id}`), onSuccess: inv }) };
};
export const useSavedAnalyses = () => useQuery({ queryKey: ["savedAnalyses"], queryFn: () => api.get<{ analyses: { id: string; title: string; createdAt: number; payload: unknown }[] }>("/api/user/saved-analyses") });
export const useSavedAnalysisMutations = () => {
  const qc = useQueryClient();
  const inv = () => void qc.invalidateQueries({ queryKey: ["savedAnalyses"] });
  return { save: useMutation({ mutationFn: (body: { title: string; payload: unknown }) => api.post("/api/user/saved-analyses", body), onSuccess: inv }), remove: useMutation({ mutationFn: (id: string) => api.del(`/api/user/saved-analyses/${id}`), onSuccess: inv }) };
};

export const useJournal = (filter: JournalFilterParams) => useQuery({ queryKey: ["journal", filter], queryFn: () => api.get<JournalResponse>(`/api/journal/trades${qs(filter as Record<string, string | undefined>)}`), staleTime: 10_000 });
export const useJournalStats = (filter: JournalFilterParams) => useQuery({ queryKey: ["journalStats", filter], queryFn: () => api.get<StatsResponse>(`/api/journal/stats${qs(filter as Record<string, string | undefined>)}`), staleTime: 10_000 });
export const useJournalMutations = () => {
  const qc = useQueryClient();
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ["journal"] });
    void qc.invalidateQueries({ queryKey: ["journalStats"] });
    void qc.invalidateQueries({ queryKey: ["circuit"] });
  };
  return {
    create: useMutation({ mutationFn: (body: Record<string, unknown>) => api.post<{ trade: JournalTrade }>("/api/journal/trades", body), onSuccess: inv }),
    update: useMutation({ mutationFn: ({ id, patch }: { id: string; patch: Partial<JournalTrade> }) => api.patch<{ trade: JournalTrade }>(`/api/journal/trades/${id}`, patch), onSuccess: inv }),
    close: useMutation({ mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.post<{ trade: JournalTrade }>(`/api/journal/trades/${id}/close`, body), onSuccess: inv }),
    remove: useMutation({ mutationFn: (id: string) => api.del(`/api/journal/trades/${id}`), onSuccess: inv }),
    seed: useMutation({ mutationFn: () => api.post<{ seeded: number }>("/api/journal/seed-test-data"), onSuccess: inv }),
    clearTest: useMutation({ mutationFn: () => api.del<{ removed: number }>("/api/journal/test-data"), onSuccess: inv }),
  };
};

export const useMonitor = () => useQuery({ queryKey: ["monitor"], queryFn: () => api.get<MonitorResponse>("/api/monitor"), refetchInterval: 10_000, staleTime: 5_000 });
export const useMonitorMutations = () => {
  const qc = useQueryClient();
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ["monitor"] });
    void qc.invalidateQueries({ queryKey: ["alerts"] });
  };
  return {
    track: useMutation({ mutationFn: (setup: TradeSetup) => api.post<{ item: MonitoredSetup; created: boolean }>("/api/monitor", { setup, source: "saved" }), onSuccess: inv }),
    trackAsset: useMutation({ mutationFn: (body: { assetId: AssetId; timeframe: Timeframe }) => api.post<{ item: MonitoredSetup; created: boolean }>("/api/monitor", { ...body, source: "manual" }), onSuccess: inv }),
    cancel: useMutation({ mutationFn: (id: string) => api.post(`/api/monitor/${id}/cancel`), onSuccess: inv }),
    close: useMutation({ mutationFn: (id: string) => api.post(`/api/monitor/${id}/close`, {}), onSuccess: inv }),
    remove: useMutation({ mutationFn: (id: string) => api.del(`/api/monitor/${id}`), onSuccess: inv }),
  };
};
export const useBacktestMutation = () => useMutation({ mutationFn: (body: BacktestRequest) => api.post<BacktestResponse>("/api/backtest", body) });
export const useGoldVerification = () => useQuery({ queryKey: ["goldVerification"], queryFn: () => api.get<GoldVerification>("/api/market/gold/verification"), refetchInterval: (q) => (q.state.data?.warming ? 5_000 : 60_000), staleTime: 30_000 });
export const useGoldInstruments = () => useQuery({ queryKey: ["goldInstruments"], queryFn: () => api.get<GoldInstruments>("/api/market/gold/instruments"), refetchInterval: (q) => (q.state.data?.warming ? 5_000 : 60_000), staleTime: 30_000 });
export const useDxy = () => useQuery({ queryKey: ["dxy"], queryFn: () => api.get<DxyResponse>("/api/market/dxy"), refetchInterval: (q) => (q.state.data?.warming ? 10_000 : 60_000), staleTime: 30_000 });
/** Progress of the one-time history download; polled only while it is running. */
export const useWarmup = () => useQuery({ queryKey: ["warmup"], queryFn: () => api.get<WarmupStatus>("/api/status/warmup"), refetchInterval: (q) => (q.state.data?.warming ? 3_000 : false), staleTime: 0 });

export const useAiStatus = () => useQuery({ queryKey: ["aiStatus"], queryFn: () => api.get<{ enabled: boolean; model: string | null; mode: string; grounding: string }>("/api/ai/status"), staleTime: 10 * 60_000 });
export const useNarrativeMutation = () =>
  useMutation({
    mutationFn: (req: { kind: "setup"; assetId: AssetId; timeframe: Timeframe } | { kind: "mtf"; assetId: AssetId } | { kind: "regime"; market: "crypto" | "gold" }) => {
      if (req.kind === "setup") return api.post<{ narrative: Narrative }>("/api/ai/setup", { assetId: req.assetId, timeframe: req.timeframe });
      if (req.kind === "mtf") return api.post<{ narrative: Narrative }>("/api/ai/mtf", { assetId: req.assetId });
      return api.post<{ narrative: Narrative }>("/api/ai/regime", { market: req.market });
    },
  });
