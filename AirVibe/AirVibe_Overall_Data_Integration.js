function decodePayload(payloadHex) {
  // Convert hex string to bytes
  const payloadHexClean = payloadHex.replace(/\s/g, "");
  const buffer = new ArrayBuffer(payloadHexClean.length / 2);
  const bytes = new Uint8Array(buffer);
  
  for (let i = 0; i < payloadHexClean.length; i += 2) {
    bytes[i / 2] = parseInt(payloadHexClean.substr(i, 2), 16);
  }
  
  // Create a DataView for structured binary data reading
  const dataView = new DataView(buffer);
  
  // Unpack the data - first 7 bytes are individual values
  const typeByte = dataView.getUint8(0);
  const status = dataView.getUint8(1);
  const firmwareRev = dataView.getUint8(2);
  const temperature = dataView.getUint8(3);
  const humidity = dataView.getUint8(4);
  const battery = dataView.getUint8(5);
  const supplyVoltage = dataView.getUint8(6);
  
  // Extract acceleration and velocity values (16-bit values from bytes 7-18)
  const accX = dataView.getUint16(7, false);  // false = big-endian
  const accY = dataView.getUint16(9, false);
  const accZ = dataView.getUint16(11, false);
  const velX = dataView.getUint16(13, false);
  const velY = dataView.getUint16(15, false);
  const velZ = dataView.getUint16(17, false);
  
  // Convert to float and divide by 1000
  const accXFloat = accX / 1000;
  const accYFloat = accY / 1000;
  const accZFloat = accZ / 1000;
  const velXFloat = velX / 1000;
  const velYFloat = velY / 1000;
  const velZFloat = velZ / 1000;
  
  // Create a dictionary with the decoded values
  const decoded = {
    'Type': typeByte === 1 ? 'Timewave' : typeByte === 2 ? 'Overall' : 'Unknown',
    'Status': status === 0 ? 'OK' : `Error (${status})`,
    'Firmware Revision': firmwareRev,
    'Temperature': temperature,
    'Humidity': humidity,
    'Battery': battery,
    'Supply Voltage': supplyVoltage,
    'Acceleration_Axis_1': accXFloat,
    'Acceleration_Axis_2': accYFloat,
    'Acceleration_Axis_3': accZFloat,
    'Velocity_Axis_1': velXFloat,
    'Velocity_Axis_2': velYFloat,
    'Velocity_Axis_3': velZFloat
  };
  
  return decoded;
}

console.log(decodePayload("02 00 00 19 00 64 00 00 09 00 09 00 0B 00 08 00 05 00 03"))