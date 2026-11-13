<?php

namespace App\Console\Commands;

use App\Services\Exporter;
use Illuminate\Console\Command;

/**
 * Checks an unpacked disclosure package: every file against SHA256SUMS, and
 * SIGNATURE against the panel's key. Run on the panel server:
 *   php artisan najva:verify-export /path/to/unzipped/folder
 */
class NajvaVerifyExport extends Command
{
    protected $signature = 'najva:verify-export {dir}';

    protected $description = 'Verify the checksums and signature of an unpacked disclosure package';

    public function handle(): int
    {
        $dir = rtrim((string) $this->argument('dir'), '/\\');
        $sums = @file_get_contents("{$dir}/SHA256SUMS");
        $sig = @file_get_contents("{$dir}/SIGNATURE");
        if ($sums === false || $sig === false) {
            $this->error('SHA256SUMS or SIGNATURE is missing.');

            return self::FAILURE;
        }
        preg_match('/export:\s*(\d+)/', $sig, $id);
        preg_match('/hmac-sha256:\s*([0-9a-f]{64})/', $sig, $mac);
        $ok = isset($id[1], $mac[1]) && hash_equals($mac[1], Exporter::sign((int) $id[1], $sums));
        $this->line($ok ? '<info>Signature: valid</info> (export #'.$id[1].')' : '<error>Signature: INVALID</error>');

        $bad = 0;
        foreach (array_filter(explode("\n", $sums)) as $line) {
            [$hash, $file] = array_pad(preg_split('/\s+/', $line, 2), 2, '');
            $actual = is_file("{$dir}/{$file}") ? hash_file('sha256', "{$dir}/{$file}") : null;
            if ($actual !== $hash) {
                $bad++;
                $this->error("Mismatch: {$file}");
            }
        }
        $this->line($bad ? "<error>{$bad} file(s) do not match.</error>" : '<info>All files match.</info>');

        return $ok && ! $bad ? self::SUCCESS : self::FAILURE;
    }
}
