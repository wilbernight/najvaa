<?php

namespace App\Http\Controllers\Panel;

use App\Http\Controllers\Controller;
use App\Models\AdminLog;
use App\Models\IpBlock;
use App\Services\Relay;
use App\Support\Jalali;
use Illuminate\Http\Request;
use Throwable;

/** Address blocks: the panel keeps the list, the relay enforces it. */
class BlockController extends Controller
{
    public function index()
    {
        return view('panel.blocks', ['blocks' => IpBlock::query()->with('creator')->latest()->get()]);
    }

    public function store(Request $request, Relay $relay)
    {
        $data = $request->validate([
            'cidr' => ['required', 'string', 'max:64'],
            'note' => ['nullable', 'string', 'max:200'],
            'hours' => ['nullable', 'integer', 'min:0', 'max:87600'],
        ]);
        $cidr = trim(Jalali::latin($data['cidr']));
        if (! $this->validCidr($cidr)) {
            return back()->withErrors(['cidr' => 'نشانی IP یا محدوده‌ی CIDR معتبر نیست (مثل 203.0.113.7 یا 203.0.113.0/24).'])->withInput();
        }
        [$addr, $bits] = array_pad(explode('/', $cidr, 2), 2, null);
        $v6 = str_contains($addr, ':');
        if ($bits !== null && (int) $bits < ($v6 ? 32 : 16)) {
            return back()->withErrors(['cidr' => 'این محدوده بیش از حد بزرگ است (کمتر از /16 برای IPv4 یا /32 برای IPv6 پذیرفته نیست).'])->withInput();
        }

        $block = IpBlock::query()->updateOrCreate(['cidr' => $cidr], [
            'note' => $data['note'] ?? null,
            'until' => ! empty($data['hours']) ? now()->addHours((int) $data['hours']) : null,
            'created_by' => auth()->id(),
        ]);
        if (! $this->push($relay)) {
            return back()->withErrors(['cidr' => 'ثبت شد، اما سرویس چت پاسخ نداد؛ در همگام‌سازی بعدی اعمال می‌شود.']);
        }
        AdminLog::record('block.added', $cidr, ['until' => $block->until?->toIso8601String(), 'note' => $block->note]);

        return back()->with('panel.flash', 'نشانی '.$cidr.' مسدود شد.');
    }

    public function destroy(IpBlock $block, Relay $relay)
    {
        $block->delete();
        $this->push($relay);
        AdminLog::record('block.removed', $block->cidr);

        return back()->with('panel.flash', 'مسدودی برداشته شد.');
    }

    private function push(Relay $relay): bool
    {
        try {
            $relay->saveBlocks(IpBlock::forRelay());

            return true;
        } catch (Throwable) {
            return false;
        }
    }

    private function validCidr(string $s): bool
    {
        [$addr, $bits] = array_pad(explode('/', $s, 2), 2, null);
        if (! filter_var($addr, FILTER_VALIDATE_IP)) {
            return false;
        }
        if ($bits === null) {
            return true;
        }
        $max = str_contains($addr, ':') ? 128 : 32;

        return ctype_digit($bits) && (int) $bits <= $max;
    }
}
