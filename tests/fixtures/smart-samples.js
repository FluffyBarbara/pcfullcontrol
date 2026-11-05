'use strict';
// Ответы smartctl -j -a (сокращённые) для HDD, SATA SSD и NVMe — для тестов разбора SMART.
const ATTR = (id, name, value, worst, thresh, rawv, extra = {}) => ({ id, name, value, worst, thresh, when_failed: '', raw: { value: rawv, string: String(rawv) }, ...extra });
const SMART_HDD = {
  device: { name: '/dev/sdc', type: 'sat', protocol: 'ATA' }, model_family: 'Seagate BarraCuda 3.5', model_name: 'ST1000DM010-2EP102', serial_number: 'Z9A1B2C3',
  firmware_version: 'CC43', user_capacity: { bytes: 1000204886016 }, logical_block_size: 512, rotation_rate: 7200, form_factor: { name: '3.5 inches' },
  interface_speed: { max: { string: '6.0 Gb/s' }, current: { string: '6.0 Gb/s' } }, smart_support: { available: true, enabled: true }, smart_status: { passed: true },
  ata_smart_attributes: { table: [ATTR(1, 'Raw_Read_Error_Rate', 83, 64, 44, 216312312), ATTR(5, 'Reallocated_Sector_Ct', 100, 100, 10, 0), ATTR(9, 'Power_On_Hours', 72, 72, 0, 24850),
    ATTR(12, 'Power_Cycle_Count', 97, 97, 20, 3120), ATTR(194, 'Temperature_Celsius', 36, 46, 0, 36), ATTR(197, 'Current_Pending_Sector', 100, 100, 0, 16), ATTR(198, 'Offline_Uncorrectable', 100, 100, 0, 0),
    ATTR(199, 'UDMA_CRC_Error_Count', 200, 200, 0, 0), ATTR(241, 'Total_LBAs_Written', 100, 253, 0, 20000000000), ATTR(242, 'Total_LBAs_Read', 100, 253, 0, 40000000000)] },
  power_on_time: { hours: 24850 }, power_cycle_count: 3120, temperature: { current: 36 },
};
const SMART_SSD = {
  device: { name: '/dev/sda', type: 'ata', protocol: 'ATA' }, model_family: 'Samsung based SSDs', model_name: 'Samsung SSD 860 EVO 500GB', serial_number: 'S3Z1NB0K123456X',
  firmware_version: 'RVT04B6Q', user_capacity: { bytes: 500107862016 }, logical_block_size: 512, rotation_rate: 0, trim: { supported: true },
  smart_support: { available: true, enabled: true }, smart_status: { passed: true },
  ata_smart_attributes: { table: [ATTR(5, 'Reallocated_Sector_Ct', 100, 100, 10, 0), ATTR(9, 'Power_On_Hours', 95, 95, 0, 21000), ATTR(177, 'Wear_Leveling_Count', 93, 93, 0, 71),
    ATTR(241, 'Total_LBAs_Written', 99, 99, 0, 46875000000)] },
  ata_device_statistics: { pages: [{ number: 7, table: [{ name: 'Percentage Used Endurance Indicator', value: 6, flags: { valid: true } }] }] },
  power_on_time: { hours: 21000 }, power_cycle_count: 1500, temperature: { current: 31 },
};
const SMART_NVME = {
  device: { name: '/dev/sdb', type: 'nvme', protocol: 'NVMe' }, model_name: 'Samsung SSD 970 EVO Plus 1TB', serial_number: 'S4EWNX0R654321A', firmware_version: '2B2QEXM7',
  nvme_total_capacity: 1000204886016, smart_support: { available: true, enabled: true }, smart_status: { passed: true },
  nvme_smart_health_information_log: { critical_warning: 0, temperature: 42, available_spare: 100, available_spare_threshold: 10, percentage_used: 4, data_units_read: 60000000,
    data_units_written: 50000000, host_reads: 1, host_writes: 2, controller_busy_time: 900, power_cycles: 2100, power_on_hours: 9000, unsafe_shutdowns: 77, media_errors: 0, num_err_log_entries: 3 },
  power_on_time: { hours: 9000 }, power_cycle_count: 2100, temperature: { current: 42 },
};

module.exports = { SMART_HDD, SMART_SSD, SMART_NVME };
