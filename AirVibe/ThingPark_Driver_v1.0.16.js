/**
 * Machine Saver • AirVibe — ThingPark / LoRa Alliance CoDec API driver
 * Uplink types supported: 1, 2, 3, 4, 5, 17
 * Downlink decode: fPort 30 (Config), 31 (Alarms), 22 (Command), 21 (Missing Segments)
 *
 * API (LoRa Alliance CoDec):
 *  - decodeUplink(input)   -> { data, warnings, errors }
 *  - encodeDownlink(input) -> { fPort, bytes }   // stub here
 *  - decodeDownlink(input) -> { data, warnings, errors }
 */

// ---- helper (kept as requested) ----
function hexToBytes(hex) {
  let clean = (hex || "").replace(/\s|0x/gi, "");
  if (clean.length % 2 !== 0) clean = "0" + clean; // pad leading 0 if odd
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) out[i/2] = parseInt(clean.substr(i,2), 16);
  return out;
}

// ---- small shared helpers ----
function _dv(input) {
  const u8 = Uint8Array.from(input || []);
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}
const _u16be = (dv, o) => dv.getUint16(o, false);
const _s16be = (dv, o) => dv.getInt16(o,  false);

const _fwToStr = (u16) => `${(u16 >> 8)}.${u16 & 0xff}`;
const _pushModeText = (v) => ({1:"Overall",2:"TimeWaveform",3:"Both"}[v] || "Unknown");
const _windowFnText = (v) => ({0:"None",1:"Hanning",2:"InverseHanning",3:"Hamming",4:"InverseHanning"}[v] || "Unknown");
const _axisMaskToList = (mask) => {
  const list = [];
  if (mask & 0x01) list.push("Axis 1");
  if (mask & 0x02) list.push("Axis 2");
  if (mask & 0x04) list.push("Axis 3");
  return list;
};

function _byteToVoltage(byteVal) {
  if (typeof byteVal !== 'number' || byteVal < 0 || byteVal > 255) {
    throw new Error("byteToVoltage: byte out of range");
  }
  const mV = byteVal * 10 + 2000;
  return mV / 1000; // volts
}


// ===================== U P L I N K =====================
function decodeUplink(input) {
  const res = { data: {}, warnings: [], errors: [] };

  try {
    if (!input || !Array.isArray(input.bytes)) throw new Error("Missing input.bytes");
    const bytes = Uint8Array.from(input.bytes);
    if (!bytes.length) throw new Error("Empty payload");

    const dv = _dv(bytes);
    const packetType = dv.getUint8(0);

    switch (packetType) {
      // ---- Type 2: Overall (requested: signed 8-bit temp; u8 voltage/charge) ----
      case 2: {
        if (bytes.length < 19) throw new Error("Type 2 too short (≥19 bytes)");
        const status       = dv.getUint8(1);
        const alarmFlag    = dv.getUint8(2);
        const tCraw        = dv.getInt8(3);      // s8
        const tempC        = tCraw;
        const vVraw        = dv.getUint8(4);     // u8
        const voltageV     = _byteToVoltage(vVraw);
        const chargePct    = dv.getUint8(5);
        const acc1_mg      = _u16be(dv,7);       // milli-gs
        const acc2_mg      = _u16be(dv,9);
        const acc3_mg      = _u16be(dv,11);
        const vel1_mips    = _u16be(dv,13);      // milli-ips
        const vel2_mips    = _u16be(dv,15);
        const vel3_mips    = _u16be(dv,17);

        res.data = {
          PacketType: 2,
          Status: status,
          AlarmFlag: alarmFlag,
          Temperature_C: tempC,
          batteryVoltage: voltageV,
          batteryLevel: chargePct,
          Overall: {
            Acceleration_milli_g_rms: [acc1_mg, acc2_mg, acc3_mg],
            Velocity_milli_ips_rms: [vel1_mips, vel2_mips, vel3_mips]
          }
        };
        break;
      }

      // ---- Type 3: Time Waveform Information ----
      case 3: {
        if (bytes.length < 11) throw new Error("Type 3 too short (≥11 bytes)");
        const transactionId      = dv.getUint8(1);
        const segmentNumber      = dv.getUint8(2);
        const errorCode          = dv.getUint8(3);
        const numberOfSegments   = _u16be(dv,4);
        const hardwareFilterCode = dv.getUint8(6);
        const samplingRateHz     = _u16be(dv,7);
        const samplesEachAxis    = _u16be(dv,9);

        res.data = {
          PacketType: 3,
          TransactionID: transactionId,
          SegmentNumber: segmentNumber,
          ErrorCode: errorCode,
          NumberOfSegments: numberOfSegments,
          HardwareFilterCode: hardwareFilterCode,
          SamplingRate_Hz: samplingRateHz,
          NumberOfSamplesEachAxis: samplesEachAxis
        };
        break;
      }

      // ---- Type 1 / 5: Time Waveform Data ----
      case 1:
      case 5: {
        if (bytes.length < 6) throw new Error("Type 1/5 too short (≥6 bytes)");
        const transactionId = dv.getUint8(1);
        const segmentNumber = _u16be(dv,2);
        const isLastSegment = (packetType === 5);

        const samplesSingleAxis = [];
        for (let o = 4; o + 1 < bytes.length; o += 2) samplesSingleAxis.push(_s16be(dv,o));

        const samplesTriplets = [];
        for (let o = 4; o + 5 < bytes.length; o += 6) {
          samplesTriplets.push([_s16be(dv,o), _s16be(dv,o + 2), _s16be(dv,o + 4)]);
        }

        res.data = {
          PacketType: packetType,
          TransactionID: transactionId,
          SegmentNumber: segmentNumber,
          LastSegment: isLastSegment,
          Samples_SingleAxis_i16: samplesSingleAxis,
          Samples_AllAxes_i16_triplets: samplesTriplets
        };
        break;
      }

      // ---- Type 4: Current Configuration ----
      case 4: {
        if (bytes.length < 41) throw new Error("Type 4 too short (≥41 bytes)");
        let o = 0;
        const version          = dv.getUint8(++o);
        const pushMode         = dv.getUint8(++o);
        const axisMask         = dv.getUint8(++o);
        const accelRange_g     = dv.getUint8(++o);
        const hwFilterCode     = dv.getUint8(++o);
        const twPushMin        = _u16be(dv, ++o); o++;
        const overallPushMin   = _u16be(dv, ++o); o++;
        const numSamples       = _u16be(dv, ++o); o++;
        const highPassHz       = _u16be(dv, ++o); o++;
        const lowPassHz        = _u16be(dv, ++o); o++;
        const windowFn         = dv.getUint8(++o);
        const alarmTestMin     = _u16be(dv, ++o); o++;
        const alarmsBitmask    = _u16be(dv, ++o); o++;
        const tempLvl_C        = _u16be(dv, ++o); o++;
        const acc1Lvl_mg       = _u16be(dv, ++o); o++;
        const acc2Lvl_mg       = _u16be(dv, ++o); o++;
        const acc3Lvl_mg       = _u16be(dv, ++o); o++;
        const vel1Lvl_mips     = _u16be(dv, ++o); o++;
        const vel2Lvl_mips     = _u16be(dv, ++o); o++;
        const vel3Lvl_mips     = _u16be(dv, ++o); o++;
        const vsmFw_u16        = _u16be(dv, ++o); o++;
        const tpmFw_u16        = _u16be(dv, ++o); o++;
        const machineOff_mg    = _u16be(dv, ++o);

        res.data = {
          PacketType: 4,
          Version: version,
          PushMode: { Value: pushMode, Text: _pushModeText(pushMode) },
          AxisMask: axisMask,
          AxisList: _axisMaskToList(axisMask),
          AccelerationRange_g: accelRange_g,
          HardwareFilterCode: hwFilterCode,
          TimeWaveformPushPeriod_min: twPushMin,
          OverallPushPeriod_min: overallPushMin,
          NumberOfSamples: numSamples,
          HighPassFilter_Hz: highPassHz,
          LowPassFilter_Hz: lowPassHz,
          WindowFunction: { Value: windowFn, Text: _windowFnText(windowFn) },
          AlarmTestPeriod_min: alarmTestMin,
          AlarmsBitmask: alarmsBitmask,
          TemperatureAlarmLevel_C: tempLvl_C,
          AccelerationAlarmLevels_milli_g: [acc1Lvl_mg, acc2Lvl_mg, acc3Lvl_mg],
          VelocityAlarmLevels_milli_ips: [vel1Lvl_mips, vel2Lvl_mips, vel3Lvl_mips],
          TPM_Firmware: _fwToStr(tpmFw_u16),
          VSM_Firmware: _fwToStr(vsmFw_u16),
          MachineOffThreshold_mg: machineOff_mg
        };
        break;
      }

      // ---- Type 17: Upgrade Data Verification ----
      case 17: {
        if (bytes.length < 3) throw new Error("Type 17 too short (≥3 bytes)");
        const missedFlag = dv.getUint8(1); // 0=all received, 1=some missed
        const count      = dv.getUint8(2);
        const missed = [];
        let o = 3;
        for (let i = 0; i < count && (o + 1) < bytes.length; i++) {
          missed.push(_u16be(dv, o));
          o += 2;
        }
        if (count > missed.length) {
          res.warnings.push(`Type 17 declared ${count} missed blocks; parsed ${missed.length}.`);
        }
        res.data = {
          PacketType: 17,
          MissedDataFlag: missedFlag,
          MissedBlockCount: count,
          MissedBlocks: missed
        };
        break;
      }

      default:
        res.errors.push(`Unsupported Packet Type: ${packetType}`);
    }

  } catch (err) {
    res.errors.push(err.message || String(err));
  }

  return res;
}

// =================== D O W N L I N K ===================
/**
 * Downlink decode by fPort:
 *  - 30: Configuration
 *  - 31: Alarms
 *  - 22: Command
 *  - 21: Missing Segments
 */
function decodeDownlink(input) {
  const res = { data: {}, warnings: [], errors: [] };

  try {
    if (!input || !Array.isArray(input.bytes)) throw new Error("Missing input.bytes");
    const bytes = Uint8Array.from(input.bytes);
    if (!bytes.length) throw new Error("Empty payload");

    const fPort = input.fPort;
    const dv = _dv(bytes);

    switch (fPort) {
      case 30: { // Configuration
        if (bytes.length < 19) throw new Error("Config downlink too short (≥19 bytes)");
        let o=0;
        const version   = dv.getUint8(o++);
        const pushMode  = dv.getUint8(o++);
        const axisMask  = dv.getUint8(o++);
        const accelG    = dv.getUint8(o++);
        const hwFilter  = dv.getUint8(o++);
        const twMin     = _u16be(dv,o); o+=2;
        const ovlMin    = _u16be(dv,o); o+=2;
        const numSamp   = _u16be(dv,o); o+=2;
        const hpHz      = _u16be(dv,o); o+=2;
        const lpHz      = _u16be(dv,o); o+=2;
        const windowFn  = dv.getUint8(o++);
        const alarmTest = _u16be(dv,o); o+=2;
        const off_mg    = _u16be(dv,o); o+=2;

        res.data = {
          fPort: 30,
          Version: version,
          PushMode: { Value: pushMode, Text: _pushModeText(pushMode) },
          AxisMask: axisMask,
          AxisList: _axisMaskToList(axisMask),
          AccelerationRange_g: accelG,
          HardwareFilterCode: hwFilter,
          TimeWaveformPushPeriod_min: twMin,
          OverallPushPeriod_min: ovlMin,
          NumberOfSamples: numSamp,
          HighPassFilter_Hz: hpHz,
          LowPassFilter_Hz: lpHz,
          WindowFunction: { Value: windowFn, Text: _windowFnText(windowFn) },
          AlarmTestPeriod_min: alarmTest,
          MachineOffThreshold_mg: off_mg
        };
        break;
      }

      case 31: { // Alarms
        if (bytes.length < 16) throw new Error("Alarms downlink too short (≥16 bytes)");
        const bitmask = _u16be(dv,0);
        const tempC   = _u16be(dv,2);
        const a1_mg   = _u16be(dv,4);
        const a2_mg   = _u16be(dv,6);
        const a3_mg   = _u16be(dv,8);
        const v1_mips = _u16be(dv,10);
        const v2_mips = _u16be(dv,12);
        const v3_mips = _u16be(dv,14);

        res.data = {
          fPort: 31,
          AlarmsBitmask: bitmask,
          TemperatureAlarmLevel_C: tempC,
          AccelerationAlarmLevels_mg: [a1_mg, a2_mg, a3_mg],
          VelocityAlarmLevels_milli_ips: [v1_mips, v2_mips, v3_mips]
        };
        break;
      }

      case 22: { // Command
        if (bytes.length < 2) throw new Error("Command downlink too short (≥2 bytes)");
        const commandId = _u16be(dv,0);
        const params    = Array.from(bytes.slice(2));
        res.data = {
          fPort: 22,
          CommandID: commandId,
          Parameters_hex: params.map(b => b.toString(16).padStart(2,"0")).join(" "),
          Parameters: params
        };
        break;
      }

      case 21: { // Missing Segments
        if (bytes.length < 2) throw new Error("Missing segments downlink too short (≥2 bytes)");
        const mode  = dv.getUint8(0); // 0=1 byte/value; 1=2 bytes/value
        const count = dv.getUint8(1);
        const vals  = [];
        if (mode === 0) {
          for (let i = 0; i < count && (2 + i) < bytes.length; i++) vals.push(dv.getUint8(2 + i));
        } else {
          let o = 2;
          for (let i = 0; i < count && (o + 1) < bytes.length; i++, o += 2) vals.push(_u16be(dv, o)); // BE; adjust if LE is required by FW
        }
        if (count > vals.length) res.warnings.push(`Declared ${count} segments but parsed ${vals.length}.`);
        res.data = { fPort: 21, ValueSizeMode: mode, Count: count, Segments: vals };
        break;
      }

      default:
        res.errors.push(`Unsupported fPort for downlink: ${fPort}`);
    }

  } catch (err) {
    res.errors.push(err.message || String(err));
  }

  return res;
}

// ================== E N C O D E  D L ===================
function encodeDownlink(input) {
  if (!input || typeof input !== "object") throw new Error("encodeDownlink: missing input");
  const d = input.data || {};

  // UI fPort (if present) -> data.fPort -> data.port -> data._fPort -> auto-detect
  let port = input.fPort;
  if (port == null) port = d.fPort ?? d.port ?? d._fPort ?? null;

  const out = []; // <-- keep as plain array

  const push16be = (v, name="u16") => {
    if (v == null || isNaN(v)) throw new Error(`encodeDownlink: missing ${name}`);
    if (v < 0 || v > 0xFFFF) throw new Error(`encodeDownlink: ${name} out of range`);
    out.push((v >>> 8) & 0xFF, v & 0xFF);
  };
  const pushU8 = (v, name="u8") => {
    if (v == null || isNaN(v)) throw new Error(`encodeDownlink: missing ${name}`);
    if (v < 0 || v > 0xFF) throw new Error(`encodeDownlink: ${name} out of range`);
    out.push(v & 0xFF);
  };
  const pushHexOrArray = (val) => {
    if (val == null) return;
    if (Array.isArray(val)) {
      for (const n of val) pushU8(n);
    } else if (typeof val === "string") {
      const u8 = hexToBytes(val);
      for (const b of u8) out.push(b);        // copy bytes into the plain array
    } else {
      throw new Error("encodeDownlink: Parameters must be number[] or hex string");
    }
  };

  // Auto-detect fPort if not supplied
  if (port == null) {
    if ("CommandID" in d) port = 22;
    else if ("AlarmsBitmask" in d || "VelocityAlarmLevels_milli_ips" in d) port = 31;
    else if ("Segments" in d || "ValueSizeMode" in d) port = 21;
    else if ("Version" in d || "HardwareFilterCode" in d) port = 30;
    else throw new Error("encodeDownlink: could not infer fPort; include fPort in JSON");
  }

  switch (port) {
    case 30: // Configuration
      pushU8(d.Version, "Version(u8)");
      pushU8(d.PushMode, "PushMode(u8)");
      pushU8(d.AxisMask, "AxisMask(u8)");
      pushU8(d.AccelerationRange_g, "AccelerationRange_g(u8)");
      pushU8(d.HardwareFilterCode, "HardwareFilterCode(u8)");
      push16be(d.TimeWaveformPushPeriod_min, "TimeWaveformPushPeriod_min(u16)");
      push16be(d.OverallPushPeriod_min, "OverallPushPeriod_min(u16)");
      push16be(d.NumberOfSamples, "NumberOfSamples(u16)");
      push16be(d.HighPassFilter_Hz, "HighPassFilter_Hz(u16)");
      push16be(d.LowPassFilter_Hz, "LowPassFilter_Hz(u16)");
      pushU8(d.WindowFunction, "WindowFunction(u8)");
      push16be(d.AlarmTestPeriod_min, "AlarmTestPeriod_min(u16)");
      push16be(d.MachineOffThreshold_mg, "MachineOffThreshold_mg(u16)");
      break;

    case 31: { // Alarms
      push16be(d.AlarmsBitmask, "AlarmsBitmask(u16)");
      push16be(d.TemperatureAlarmLevel_C, "TemperatureAlarmLevel_C(u16)");
      const acc = d.AccelerationAlarmLevels_mg || [];
      const vel = d.VelocityAlarmLevels_milli_ips || [];
      push16be(acc[0] ?? 0, "Acc1(u16)"); push16be(acc[1] ?? 0, "Acc2(u16)"); push16be(acc[2] ?? 0, "Acc3(u16)");
      push16be(vel[0] ?? 0, "Vel1(u16)"); push16be(vel[1] ?? 0, "Vel2(u16)"); push16be(vel[2] ?? 0, "Vel3(u16)");
      break;
    }

    case 22: // Command
      push16be(d.CommandID, "CommandID(u16)");
      pushHexOrArray(d.Parameters);
      break;

    case 21: { // Missing Segments
      const mode = d.ValueSizeMode ?? 0;
      pushU8(mode, "ValueSizeMode(u8)");
      const segs = d.Segments || [];
      pushU8(segs.length, "Count(u8)");
      if (mode === 0) {
        for (const v of segs) pushU8(v, "Segment(u8)");
      } else {
        for (const v of segs) push16be(v, "Segment(u16)");
      }
      break;
    }

    default:
      throw new Error(`encodeDownlink: unsupported fPort ${port}`);
  }

  // IMPORTANT: return a plain array of numbers
  return { fPort: Number(port), bytes: out };
}



// ---- export for Node/CommonJS (device-catalog tooling) ----
if (typeof module !== "undefined") {
  module.exports = {
    decodeUplink,
    encodeDownlink,
    decodeDownlink,
    // optional helper export for tests
    _hexToBytes: hexToBytes
  };
}
