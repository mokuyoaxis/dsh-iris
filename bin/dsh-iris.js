#!/usr/bin/env node
import { doctor, formatDoctorReport } from '../lib/doctor.js';

function usage() {
  return [
    'Usage: dsh-iris doctor [--json]',
    '',
    'Runs offline diagnostics only. It does not start DSH or send provider requests.'
  ].join('\n');
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage());
  process.exitCode = 0;
} else if (args[0] !== 'doctor' || args.some((arg, index) => index > 0 && arg !== '--json')) {
  console.error(usage());
  process.exitCode = 2;
} else {
  const report = await doctor();
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
  process.exitCode = report.exitCode;
}
