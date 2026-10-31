import { writePrivate } from '../dist/private-files.js';

process.on('SIGXFSZ', () => {});
try {
  await writePrivate(process.argv[2]!, 'x'.repeat(4096));
  process.exitCode = 1;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EFBIG') throw error;
}
