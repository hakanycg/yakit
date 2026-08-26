/**
 * Istasyonun kendi konumuna gore "hava aydinlik mi" penceresi.
 *
 * Kiosk ekrani sabit saatlerle (07:00-19:00) gunduz/gece moduna geciyordu. Turkiye
 * icin bu yanlis: aralikta hava 17:30'da kararmisken ekran hala bembeyaz, haziranda
 * 19:00'da gupegunduzken koyuya donuyordu. Antalya ile Erzurum'un ayni anda kararmasi
 * da beklenmemeli.
 *
 * Hesap istasyonun enlem/boylamindan yapilir - bu bilgi kiosk'a zaten geliyor
 * (bkz. routes/kiosk.ts station payload), kurulumda ek bir ayar girilmez.
 *
 * Esik olarak gunes diski degil SIVIL ALACAKARANLIK (-6 derece) kullaniliyor: ekranin
 * takip etmesi gereken sey gunesin dogusu degil, hava aydinlik mi oldugudur. Bu esik
 * sabah gun dogumundan ~30 dk once baslar, aksam gun batimindan ~30 dk sonra biter -
 * yani ekran gozle gorulen aydinlikla birlikte doner.
 *
 * Algoritma standart gunes konumu hesabidir (SunCalc ile ayni yaklasim); dakika
 * mertebesinde dogruluk bu is icin fazlasiyla yeterlidir - bu kozmetik bir gecistir.
 */

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2_440_588;
const J2000 = 2_451_545;
/** Yer ekseninin egikligi. */
const OBLIQUITY = 23.4397 * RAD;
/** Sivil alacakaranlik: gunes merkezi ufkun 6 derece altinda. */
const CIVIL_TWILIGHT = -6 * RAD;

function toDays(timestamp: number): number {
  return timestamp / DAY_MS - 0.5 + J1970 - J2000;
}

function fromJulian(j: number): number {
  return (j + 0.5 - J1970) * DAY_MS;
}

function solarMeanAnomaly(d: number): number {
  return RAD * (357.5291 + 0.98560028 * d);
}

function eclipticLongitude(m: number): number {
  const center = RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m));
  const perihelion = RAD * 102.9372;
  return m + center + perihelion + Math.PI;
}

function declination(eclipticLng: number): number {
  return Math.asin(Math.sin(OBLIQUITY) * Math.sin(eclipticLng));
}

export interface LightWindow {
  /** Havanin aydinlanmaya basladigi an (unix ms). */
  start: number;
  /** Havanin karardigi an (unix ms). */
  end: number;
}

/**
 * Verilen an ve konum icin o gunun aydinlik penceresi.
 *
 * Kutup bolgelerinde gunes hic dogmayabilir ya da hic batmayabilir; boyle bir yerde
 * "gun dogumu" diye bir an yoktur ve hesap NaN uretir. Cagiran taraf bu durumda
 * saat tabanli yedege dusebilsin diye null donulur (bkz. useDayNightMode.ts).
 */
export function lightWindow(now: number, latitude: number, longitude: number): LightWindow | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const lw = -longitude * RAD;
  const phi = latitude * RAD;
  const d = toDays(now);

  const n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
  const ds = 0.0009 + lw / (2 * Math.PI) + n;
  const m = solarMeanAnomaly(ds);
  const l = eclipticLongitude(m);
  const dec = declination(l);
  // Gunesin gun icindeki en yuksek noktasi (yerel ogle) - dogus ve batis bunun
  // etrafinda simetriktir.
  const jNoon = J2000 + ds + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l);

  const cosH = (Math.sin(CIVIL_TWILIGHT) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (!(cosH >= -1 && cosH <= 1)) return null; // kutup gunu / kutup gecesi
  const h = Math.acos(cosH);

  const jSet = J2000 + (0.0009 + (h + lw) / (2 * Math.PI) + n) + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l);
  const jRise = jNoon - (jSet - jNoon);

  return { start: fromJulian(jRise), end: fromJulian(jSet) };
}

/** O an hava aydinlik mi? Hesaplanamayan konumlarda null. */
export function isDaylight(now: number, latitude: number, longitude: number): boolean | null {
  const window = lightWindow(now, latitude, longitude);
  if (!window) return null;
  return now >= window.start && now < window.end;
}
