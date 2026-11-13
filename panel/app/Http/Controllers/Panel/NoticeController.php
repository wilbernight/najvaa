<?php

namespace App\Http\Controllers\Panel;

use App\Http\Controllers\Controller;
use App\Models\AdminLog;
use App\Models\ServiceNotice;
use App\Services\Relay;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Throwable;

/** A service notice shown in every open app (maintenance, outage, policy). */
class NoticeController extends Controller
{
    public function index()
    {
        return view('panel.notices', ['notices' => ServiceNotice::query()->with('creator')->latest()->limit(50)->get()]);
    }

    public function store(Request $request, Relay $relay)
    {
        $data = $request->validate([
            'text' => ['required', 'string', 'max:500'],
            'level' => ['required', Rule::in(array_keys(ServiceNotice::LEVELS))],
            'hours' => ['nullable', 'integer', 'min:0', 'max:720'],
        ]);
        $until = ! empty($data['hours']) ? now()->addHours((int) $data['hours']) : null;
        try {
            $r = $relay->notice($data['text'], $data['level'], $until?->getTimestampMs() ?? 0);
        } catch (Throwable) {
            return back()->withErrors(['text' => 'سرویس چت پاسخ نداد؛ اعلان فرستاده نشد.'])->withInput();
        }
        ServiceNotice::query()->whereNull('cleared_at')->update(['cleared_at' => now()]);
        ServiceNotice::query()->create($data + ['until' => $until, 'sent_to' => (int) ($r['sent'] ?? 0), 'created_by' => auth()->id()]);
        AdminLog::record('notice.sent', null, ['level' => $data['level'], 'sent' => $r['sent'] ?? 0]);

        return back()->with('panel.flash', 'اعلان برای '.\App\Support\Jalali::digits((int) ($r['sent'] ?? 0)).' دستگاه آنلاین فرستاده شد.');
    }

    public function clear(Relay $relay)
    {
        try {
            $relay->notice(null);
        } catch (Throwable) {
            return back()->withErrors(['text' => 'سرویس چت پاسخ نداد.']);
        }
        ServiceNotice::query()->whereNull('cleared_at')->update(['cleared_at' => now()]);
        AdminLog::record('notice.cleared');

        return back()->with('panel.flash', 'اعلان برداشته شد.');
    }
}
