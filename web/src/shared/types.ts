export type RoleName = "super_admin" | "admin" | "operator" | "viewer";
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
  transactionId: number | null;
  username: string | null;
  createdAt: string;
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
