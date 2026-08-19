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
  mustChangePassword: boolean;
  email: string | null;
  phone: string | null;
  notifyEmail: boolean;
  notifySms: boolean;
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
}

export interface Station {
  id: number;
  slug: string;
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
