<?php

namespace App\Http\Controllers\Panel;

use App\Http\Controllers\Controller;
use App\Models\AbuseReport;
use App\Models\AdminLog;
use App\Models\LegalCase;
use App\Models\Room;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class ReportController extends Controller
{
    public static function list(Request $request)
    {
        $f = (string) $request->query('f', 'new');

        return AbuseReport::query()
            ->when($f !== 'all', fn ($b) => $b->where('status', $f))
            ->orderByRaw("case when reason in ('csam','terror','threat') then 0 else 1 end")
            ->latest('received_at')
            ->limit(300)
            ->get();
    }

    public function index(Request $request)
    {
        return view('panel.reports.index', ['reports' => self::list($request)]);
    }

    public function show(Request $request, AbuseReport $report)
    {
        AdminLog::record('report.viewed', $report->remote_id);
        $room = Room::query()->where('room_id', $report->room_id)->first();

        return view('panel.reports.show', [
            'reports' => self::list($request),
            'report' => $report,
            'room' => $room,
            'others' => AbuseReport::query()->where('room_id', $report->room_id)->whereKeyNot($report->id)->latest('received_at')->limit(20)->get(),
            'openCases' => LegalCase::query()->whereIn('status', LegalCase::OPEN)->latest()->limit(100)->get(),
        ]);
    }

    public function update(Request $request, AbuseReport $report)
    {
        $data = $request->validate([
            'status' => ['required', Rule::in(array_keys(AbuseReport::STATUSES))],
            'resolution' => ['nullable', 'string', 'max:2000'],
            'legal_case_id' => ['nullable', 'integer', 'exists:legal_cases,id'],
        ]);
        $report->update($data + ['handled_by' => auth()->id(), 'handled_at' => now()]);
        if ($report->legal_case_id && $report->wasChanged('legal_case_id')) {
            $report->legalCase->log('report', 'گزارش تخلف #'.$report->remote_id.' به پرونده پیوست شد ('.AbuseReport::REASONS[$report->reason].').', ['report' => $report->id]);
        }
        AdminLog::record('report.updated', $report->remote_id, ['status' => $report->status]);

        return back()->with('panel.flash', 'گزارش به‌روز شد.');
    }
}
