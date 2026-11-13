<?php

namespace App\Http\Controllers\Panel;

use App\Http\Controllers\Controller;
use App\Models\AbuseReport;
use App\Models\LegalCase;
use App\Support\Jalali;
use Illuminate\Http\Request;

/**
 * Transparency report: how many requests came in, of which kinds, and how
 * they ended, per Jalali half-year (or year). Counts only, no names.
 */
class TransparencyController extends Controller
{
    private function data(Request $request): array
    {
        $year = (int) Jalali::latin((string) $request->query('y', (string) Jalali::year(now())));
        $half = (string) $request->query('h', 'all');   // 1 | 2 | all
        [$fm, $tm] = match ($half) { '1' => [1, 6], '2' => [7, 12], default => [1, 12] };
        $from = Jalali::parse(sprintf('%d/%02d/01', $year, $fm));
        $to = $tm === 12 ? Jalali::parse(sprintf('%d/01/01', $year + 1)) : Jalali::parse(sprintf('%d/%02d/01', $year, $tm + 1));

        $cases = LegalCase::query()->whereBetween('received_on', [$from->toDateString(), $to->copy()->subDay()->toDateString()])->withCount('rooms')->get();
        $reports = AbuseReport::query()->whereBetween('received_at', [$from, $to])->get();

        return [
            'year' => $year, 'half' => $half, 'from' => $from, 'to' => $to->copy()->subDay(),
            'total' => $cases->count(),
            'rooms' => $cases->sum('rooms_count'),
            'byKind' => collect(LegalCase::KINDS)->map(fn ($l, $k) => $cases->where('kind', $k)->count()),
            'byStatus' => collect(LegalCase::STATUSES)->map(fn ($l, $k) => $cases->where('status', $k)->count()),
            'reports' => $reports->count(),
            'reportsByReason' => collect(AbuseReport::REASONS)->map(fn ($l, $r) => $reports->where('reason', $r)->count()),
            'reportsByStatus' => collect(AbuseReport::STATUSES)->map(fn ($l, $s) => $reports->where('status', $s)->count()),
        ];
    }

    public function index(Request $request)
    {
        return view('panel.transparency', $this->data($request));
    }

    public function csv(Request $request)
    {
        $d = $this->data($request);
        $rows = [['section', 'key', 'label', 'count']];
        foreach ($d['byKind'] as $k => $n) {
            $rows[] = ['case_kind', $k, LegalCase::KINDS[$k], $n];
        }
        foreach ($d['byStatus'] as $k => $n) {
            $rows[] = ['case_outcome', $k, LegalCase::STATUSES[$k], $n];
        }
        foreach ($d['reportsByReason'] as $k => $n) {
            $rows[] = ['report_reason', $k, AbuseReport::REASONS[$k], $n];
        }
        $rows[] = ['totals', 'cases', 'درخواست‌ها', $d['total']];
        $rows[] = ['totals', 'rooms', 'اتاق‌های درگیر', $d['rooms']];
        $rows[] = ['totals', 'reports', 'گزارش‌های تخلف', $d['reports']];

        return response()->streamDownload(function () use ($rows) {
            $h = fopen('php://output', 'w');
            fwrite($h, "\xEF\xBB\xBF");
            foreach ($rows as $r) {
                fputcsv($h, $r, ',', '"', '');
            }
            fclose($h);
        }, "najva-transparency-{$d['year']}-{$d['half']}.csv", ['Content-Type' => 'text/csv; charset=UTF-8']);
    }
}
