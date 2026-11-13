<?php

namespace App\Http\Controllers\Panel;

use App\Http\Controllers\Controller;
use App\Models\AbuseReport;
use App\Models\AdminLog;
use App\Models\Domain;
use App\Models\LegalCase;
use App\Models\Metric;
use App\Models\Room;
use App\Models\ServiceCheck;
use App\Models\ServiceNotice;

class DashboardController extends Controller
{
    public function index()
    {
        $last = Metric::query()->latest('created_at')->first();
        $trend = Metric::query()->where('created_at', '>=', now()->subDay())->orderBy('created_at')
            ->get(['total_bytes', 'devices', 'live_rooms', 'created_at']);
        // One point per ~30 min keeps the sparkline light.
        $trend = $trend->groupBy(fn ($m) => $m->created_at->format('Y-m-d H:').($m->created_at->minute < 30 ? '0' : '3'))
            ->map(fn ($g) => $g->last())->values();

        // Per-day counts for the last 14 days (oldest first), for the KPI sparklines.
        $daily = function ($query, string $col) {
            $from = today()->subDays(13);
            $rows = $query->where($col, '>=', $from)->get([$col])
                ->countBy(fn ($r) => $r->{$col}->toDateString());
            $out = [];
            for ($d = $from->copy(); $d->lte(today()); $d->addDay()) {
                $out[] = (int) ($rows[$d->toDateString()] ?? 0);
            }

            return $out;
        };
        $reportsDaily = $daily(AbuseReport::query(), 'received_at');
        $casesDaily = $daily(LegalCase::query(), 'created_at');

        return view('panel.dashboard', [
            'last' => $last,
            'trend' => $trend,
            'reportsDaily' => $reportsDaily,
            'casesDaily' => $casesDaily,
            'reportsWeek' => [array_sum(array_slice($reportsDaily, 7)), array_sum(array_slice($reportsDaily, 0, 7))],
            'rooms' => [
                'total' => Room::query()->count(),
                'online' => Room::query()->where('online', '>', 0)->count(),
                'held' => Room::query()->where('hold', true)->count(),
                'suspended' => Room::query()->where('suspended', true)->count(),
                'watched' => Room::query()->where('watch_until', '>', now())->count(),
            ],
            'cases' => [
                'open' => LegalCase::query()->whereIn('status', LegalCase::OPEN)->count(),
                'overdue' => LegalCase::query()->whereIn('status', LegalCase::OPEN)->whereDate('due_on', '<', today())->count(),
                'recent' => LegalCase::query()->whereIn('status', LegalCase::OPEN)->orderByRaw('due_on is null')->orderBy('due_on')->limit(5)->get(),
            ],
            'reports' => [
                'new' => AbuseReport::query()->where('status', 'new')->count(),
                'severe' => AbuseReport::query()->where('status', 'new')->whereIn('reason', AbuseReport::SEVERE)->count(),
            ],
            'services' => ServiceCheck::query()->orderBy('key')->get(),
            'domains' => Domain::query()->orderBy('name')->get(),
            'notice' => ServiceNotice::query()->whereNull('cleared_at')->latest()->first(),
            'security' => [
                'failed' => AdminLog::query()->whereIn('action', ['login.failed', 'lockout', 'stepup.failed', 'session.mismatch', 'access.denied'])
                    ->where('created_at', '>=', now()->subDay())->count(),
                'recent' => AdminLog::query()->latest('id')->limit(8)->get(),
            ],
        ]);
    }

    /** Small JSON for the badges and the live counters (polled every 30 s). */
    public function pulse()
    {
        $last = Metric::query()->latest('created_at')->first();

        return response()->json([
            'devices' => $last?->devices ?? 0,
            'live' => $last?->live_rooms ?? 0,
            'reports' => AbuseReport::query()->where('status', 'new')->count(),
            'cases' => LegalCase::query()->whereIn('status', LegalCase::OPEN)->count(),
            'overdue' => LegalCase::query()->whereIn('status', LegalCase::OPEN)->whereDate('due_on', '<', today())->count(),
        ]);
    }
}
