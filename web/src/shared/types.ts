export type RoleName = "super_admin" | "tenant_admin" | "admin" | "operator" | "viewer";
export type FuelType = "benzin" | "motorin" | "lpg";
export type PumpStatus = "idle" | "reserved" | "dispensing" | "fault" | "offline";
export type TransactionStatus =
  | "created"
  | "paid"
  | "authorized"
  | "dispensing"
  | "completed"
  | "cancelled"
  | "failed";

export interface CurrentUser {
  id: number;
  username: string;
  displayName: string;
  role: RoleName;
  stationId: number | null;
  stationName: string | null;
  tenantId: number | null;
  tenantName: string | null;
  mustChangePassword: boolean;
  email: string | null;
  phone: string | null;
  notifyEmail: boolean;
  notifySms: boolean;
  totpEnabled: boolean;
}

export interface Pump {
  id: number;
  stationId: number;
  number: number;
  label: string;
  status: PumpStatus;
  fuelTypes: FuelType[];
  posX: number;
  posY: number;
  faultCode: string | null;
  faultMessage: string | null;
  currentTransactionId: number | null;
  updatedAt: string;
}

export interface Transaction {
  id: number;
  stationId: number;
  pumpId: number;
  plate: string;
  plateSource: "manual" | "lpr";
  fuelType: FuelType;
  amountMode: "amount" | "liters" | "full_tank";
  requestedAmount: number | null;
  requestedLiters: number | null;
  pricePerLiter: number;
  dispensedLiters: number;
  totalAmount: number;
  discountCode: string | null;
  discountAmount: number;
  loyaltyPointsRedeemed: number;
  loyaltyPointsEarned: number;
  chargeAmount: number;
  paymentMethod: string;
  paymentStatus: string;
  status: TransactionStatus;
  startedAt: string | null;
  completedAt: string | null;
  cancelledReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Alarm {
  id: number;
  stationId: number;
  pumpId: number | null;
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
  status: "active" | "acknowledged" | "resolved";
  acknowledgedBy: number | null;
  acknowledgedAt: string | null;
  resolvedBy: number | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface FuelPrice {
  fuelType: FuelType;
  label: string;
  pricePerLiter: number;
  updatedAt?: string;
  inStock?: boolean;
}

export type TankStatus = "ok" | "low" | "critical";

export interface FuelTank {
  fuelType: FuelType;
  capacityLiters: number;
  currentLiters: number;
  lowStockThresholdLiters: number;
  averageCostPerLiter: number;
  percentFull: number;
  status: TankStatus;
  updatedAt: string;
}

export type SupportCategory = "payment" | "dispenser" | "receipt" | "other";

export interface SupportRequest {
  id: number;
  stationId: number;
  kioskId: number | null;
  pumpId: number | null;
  pumpNumber: number | null;
  transactionId: number | null;
  category: SupportCategory;
  categoryLabel: string;
  message: string | null;
  contactPhone: string | null;
  status: "open" | "resolved";
  alarmId: number | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
}

export interface ReconciliationPaymentRow {
  paymentMethod: string;
  count: number;
  amount: number;
}

export interface ReconciliationFuelRow {
  fuelType: FuelType;
  count: number;
  liters: number;
  amount: number;
}

export interface PendingTransaction {
  id: number;
  plate: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  amount: number;
  createdAt: string;
}

export interface ReconciliationRecord {
  id: number;
  businessDate: string;
  expectedTotal: number;
  declaredTotal: number;
  difference: number;
  pendingCount: number;
  breakdown: ReconciliationPaymentRow[];
  note: string | null;
  closedAt: string;
  closedBy: string | null;
}

export interface DaySummary {
  businessDate: string;
  transactionCount: number;
  grossAmount: number;
  discountAmount: number;
  expectedTotal: number;
  refundedAmount: number;
  refundedCount: number;
  byPaymentMethod: ReconciliationPaymentRow[];
  byFuelType: ReconciliationFuelRow[];
  pending: PendingTransaction[];
  closed: ReconciliationRecord | null;
}

export type KioskHealthStatus = "online" | "offline" | "never_seen";

export interface FleetKiosk {
  id: number;
  label: string;
  anydeskId: string | null;
  stationId: number;
  stationName: string;
  stationCode: string | null;
  stationActive: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  status: KioskHealthStatus;
  offlineMinutes: number | null;
  stationFaultAlarms: number;
}

export interface KioskFleetSummary {
  total: number;
  online: number;
  offline: number;
  neverSeen: number;
  stationsWithFault: number;
}

export interface FuelTankReading {
  id: number;
  fuelType: FuelType;
  measuredLiters: number;
  bookLiters: number;
  varianceLiters: number;
  throughputLiters: number;
  variancePct: number;
  previousReadingId: number | null;
  alarmId: number | null;
  note: string | null;
  measuredAt: string;
  createdAt: string;
  source: "manual" | "auto";
  temperatureCelsius: number | null;
  username: string | null;
}

export interface VarianceSummaryRow {
  fuelType: FuelType;
  readingCount: number;
  totalVarianceLiters: number;
  totalThroughputLiters: number;
  netVariancePct: number;
  lastMeasuredAt: string | null;
  lastVarianceLiters: number | null;
}

export interface VarianceSettings {
  thresholdPct: number;
  minLiters: number;
}

export type FuelStockMovementType = "delivery" | "sale" | "adjustment";

export interface FuelStockMovement {
  id: number;
  fuelType: FuelType;
  type: FuelStockMovementType;
  liters: number;
  balanceAfter: number;
  supplier: string | null;
  deliveryRef: string | null;
  note: string | null;
  unitCost: number | null;
  /** Teslimat kabul farki. Olculmeyen teslimatta hepsi null. */
  declaredLiters: number | null;
  measuredBeforeLiters: number | null;
  measuredAfterLiters: number | null;
  deliveryVarianceLiters: number | null;
  deliveryVariancePct: number | null;
  transactionId: number | null;
  username: string | null;
  createdAt: string;
}

/** Fiyat degisikligi guvenlik kontrolu uyarisi (bkz. server/src/services/priceGuardService.ts). */
export interface PriceGuardWarning {
  currentPrice: number;
  newPrice: number;
  changePct: number;
  exceedsThreshold: boolean;
  belowCost: boolean;
  averageCostPerLiter: number | null;
  requiresConfirmation: boolean;
  message: string;
}

export interface DeliveryVariance {
  acceptedLiters: number;
  varianceLiters: number | null;
  variancePct: number | null;
  exceedsThreshold: boolean;
  unmeasured: boolean;
}

export interface SupplierDeliveryVarianceRow {
  supplier: string;
  deliveryCount: number;
  measuredCount: number;
  declaredLiters: number;
  acceptedLiters: number;
  varianceLiters: number;
  variancePct: number;
  lastDeliveryAt: string | null;
}

export interface SupplierSummaryRow {
  supplier: string;
  fuelType: FuelType;
  deliveryCount: number;
  totalLiters: number;
  avgUnitCost: number | null;
  lastDeliveryAt: string;
}

export interface Station {
  tenantId: number | null;
  id: number;
  slug: string;
  /** "STM1234" - kiosk adresi ve destek kimligi. Sir DEGILDIR (bkz. server/src/utils/stationCode.ts). */
  code: string | null;
  /** true ise kiosk uclari cihaz tokeni olmadan calismaz. */
  requireKioskToken?: boolean;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  active?: boolean;
  createdAt?: string;
  pumpCount?: number;
  transactionCount?: number;
  activeAlarms?: number;
  userCount?: number;
  lastHeartbeatAt?: string | null;
  lastSyncedAt?: string | null;
  agentConfigured?: boolean;
}

export interface StationKiosk {
  id: number;
  stationId: number;
  label: string;
  anydeskId: string | null;
  /** Bu fiziksel kiosk'un cihaz tokeni - kurulum adresine ?device=... olarak eklenir. */
  deviceToken: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface AdminUser {
  id: number;
  username: string;
  displayName: string;
  role: RoleName;
  stationId: number | null;
  stationName: string | null;
  active: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  locked: boolean;
  email: string | null;
  phone: string | null;
  notifyEmail: boolean;
  notifySms: boolean;
}

export interface AuditEntry {
  id: number;
  stationId: number | null;
  userId: number | null;
  username: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: unknown;
  ipAddress: string | null;
  createdAt: string;
}
