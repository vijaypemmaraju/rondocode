/* The slice of Web Bluetooth the mask uses. The DOM lib does not ship these
 * (the API is Chromium-only), and the full @types/web-bluetooth is a
 * dependency for a dozen lines. */

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly uuid: string
  readonly value: DataView | undefined
  writeValueWithResponse(value: ArrayBufferView | ArrayBuffer): Promise<void>
  writeValueWithoutResponse(value: ArrayBufferView | ArrayBuffer): Promise<void>
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>
}

interface BluetoothRemoteGATTService {
  readonly uuid: string
  getCharacteristic(uuid: string): Promise<BluetoothRemoteGATTCharacteristic>
}

interface BluetoothRemoteGATTServer {
  readonly connected: boolean
  connect(): Promise<BluetoothRemoteGATTServer>
  disconnect(): void
  getPrimaryService(uuid: string): Promise<BluetoothRemoteGATTService>
}

interface WatchAdvertisementsOptions {
  signal?: AbortSignal
}

interface BluetoothDevice extends EventTarget {
  readonly id: string
  readonly name?: string
  readonly gatt?: BluetoothRemoteGATTServer
  /** Behind the same Chrome flag as getDevices(): a permitted device is not
   *  connectable until it has been seen advertising again. */
  watchAdvertisements?(options?: WatchAdvertisementsOptions): Promise<void>
}

interface BluetoothLEScanFilter {
  name?: string
  namePrefix?: string
  services?: string[]
}

interface RequestDeviceOptions {
  filters?: BluetoothLEScanFilter[]
  optionalServices?: string[]
  acceptAllDevices?: boolean
}

interface Bluetooth {
  requestDevice(options?: RequestDeviceOptions): Promise<BluetoothDevice>
  /** The devices this origin was already allowed to use. Chrome ships it
   *  behind chrome://flags/#enable-web-bluetooth-new-permissions-backend, so
   *  it is optional here and absent by default. */
  getDevices?(): Promise<BluetoothDevice[]>
}

interface Navigator {
  readonly bluetooth?: Bluetooth
}
