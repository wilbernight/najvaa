<?php

namespace App\Http\Controllers\Panel;

use App\Http\Controllers\Controller;
use App\Models\AdminLog;
use Illuminate\Http\Request;

class AuditController extends Controller
{
    public function index(Request $request)
    {
        $q = trim((string) $request->query('q', ''));
        $kind = (string) $request->query('k', '');
        $logs = AdminLog::query()
            ->when($q !== '', fn ($b) => $b->where(fn ($w) => $w->where('email', 'like', "%{$q}%")->orWhere('target', 'like', "%{$q}%")->orWhere('ip', 'like', "{$q}%")->orWhere('action', 'like', "%{$q}%")))
            ->when($kind === 'security', fn ($b) => $b->where(fn ($w) => $w->where('action', 'like', 'login%')->orWhere('action', 'like', 'stepup%')->orWhere('action', 'like', 'session%')->orWhereIn('action', ['lockout', 'access.denied', 'logout'])))
            ->when($kind === 'legal', fn ($b) => $b->where(fn ($w) => $w->where('action', 'like', 'case%')->orWhere('action', 'like', 'export%')->orWhereIn('action', ['room.hold', 'room.released', 'room.watch', 'room.unwatch', 'room.connlog.viewed'])))
            ->when($kind === 'rooms', fn ($b) => $b->where('action', 'like', 'room%'))
            ->latest('id')
            ->paginate(100)
            ->withQueryString();

        return view('panel.audit', ['logs' => $logs, 'verify' => session('panel.audit_verify')]);
    }

    public function verify()
    {
        $r = AdminLog::verifyChain();
        AdminLog::record('audit.verified', null, $r);

        return back()->with('panel.audit_verify', $r);
    }

    public function csv()
    {
        AdminLog::record('audit.exported');

        return response()->streamDownload(function () {
            $h = fopen('php://output', 'w');
            fwrite($h, "\xEF\xBB\xBF");
            fputcsv($h, ['id', 'time_utc', 'email', 'action', 'target', 'detail', 'ip', 'user_agent', 'prev_hash', 'hash'], ',', '"', '');
            foreach (AdminLog::query()->orderBy('id')->lazy(500) as $l) {
                fputcsv($h, [$l->id, $l->created_at?->utc()->toIso8601ZuluString(), $l->email, $l->action, $l->target,
                    json_encode($l->detail, JSON_UNESCAPED_UNICODE), $l->ip, $l->ua, $l->prev_hash, $l->hash], ',', '"', '');
            }
            fclose($h);
        }, 'najva-audit-'.now()->format('Ymd-His').'.csv', ['Content-Type' => 'text/csv; charset=UTF-8', 'Cache-Control' => 'no-store']);
    }
}
