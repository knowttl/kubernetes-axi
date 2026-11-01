#!/usr/bin/env -S node
import { writeFileSync } from 'node:fs';

writeFileSync(process.env.SYNTHETIC_PROGRAM_MARKER!, 'executed');
