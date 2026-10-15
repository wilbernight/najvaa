<?php

namespace App\Console\Commands;

use App\Models\Room;
use Illuminate\Console\Command;

/**
 * Finds the 7-digit code of each room. The relay only knows
 * roomId = HKDF(code) (see the chat client), and there are only 10^7 codes,
 * so every id can be matched by trying them all. The room password never
 * reaches the server, so knowing the code still gives no access to content.
 */
class NajvaCodes extends Command
{
    protected $signature = 'najva:codes';

    protected $description = 'Work out the 7-digit code of rooms that do not have one yet';

    public function handle(): int
    {
        $want = Room::query()->whereNull('code')->pluck('id', 'room_id')->all();
        if (! $want) {
            return self::SUCCESS;
        }

        $salt = str_repeat("\0", 32);
        $left = count($want);
        for ($n = 0; $n < 10_000_000 && $left > 0; $n++) {
            $code = str_pad((string) $n, 7, '0', STR_PAD_LEFT);
            $id = rtrim(strtr(base64_encode(hash_hkdf('sha256', 'najva/room/'.$code, 16, 'wn1/room-id', $salt)), '+/', '-_'), '=');
            if (isset($want[$id])) {
                Room::query()->whereKey($want[$id])->update(['code' => $code]);
                unset($want[$id]);
                $left--;
            }
        }

        return self::SUCCESS;
    }
}
