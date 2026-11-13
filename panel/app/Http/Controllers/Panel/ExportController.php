<?php

namespace App\Http\Controllers\Panel;

use App\Http\Controllers\Controller;
use App\Models\AdminLog;
use App\Models\DisclosureExport;
use App\Models\LegalCase;
use App\Models\LegalCaseRoom;
use App\Services\Exporter;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use RuntimeException;
use Throwable;

class ExportController extends Controller
{
    public function store(Request $request, LegalCase $case, Exporter $exporter)
    {
        $data = $request->validate([
            'link_id' => ['required', 'integer'],
            'with_content' => ['nullable', 'boolean'],
        ]);
        $link = LegalCaseRoom::query()->where('legal_case_id', $case->id)->findOrFail($data['link_id']);
        $with = (bool) ($data['with_content'] ?? false);

        try {
            [$export, $password] = $exporter->build($case, $link->room_id, $with);
        } catch (RuntimeException $e) {
            $msg = match ($e->getMessage()) {
                'room-not-found' => 'این اتاق روی سرور داده‌ای ندارد.',
                'too-big' => 'حجم داده‌ی رمزشده‌ی اتاق از سقف بسته بیشتر است؛ بسته را بدون محتوا بسازید.',
                default => 'ساخت بسته ممکن نشد: '.$e->getMessage(),
            };

            return back()->withErrors(['export' => $msg]);
        } catch (Throwable $e) {
            report($e);

            return back()->withErrors(['export' => 'سرویس چت پاسخ نداد؛ بسته ساخته نشد.']);
        }

        $case->log('export', null, ['room' => $link->label, 'export' => $export->id, 'content' => $with, 'sha256' => $export->sha256]);
        AdminLog::record('export.created', $case->ref, ['export' => $export->id, 'room' => $link->label, 'content' => $with, 'sha256' => $export->sha256]);

        // The password is shown once, on the next page only, and never stored.
        return back()->with('panel.export_password', ['id' => $export->id, 'password' => $password]);
    }

    public function download(DisclosureExport $export)
    {
        abort_unless($export->available(), 410, 'این بسته منقضی یا پاک شده است.');
        $path = Storage::disk('local')->path($export->file);
        abort_unless(is_file($path) && hash_equals((string) $export->sha256, hash_file('sha256', $path)), 409, 'فایل بسته با چکیده‌ی ثبت‌شده نمی‌خواند.');

        $export->increment('downloads');
        AdminLog::record('export.downloaded', (string) $export->id, ['sha256' => $export->sha256]);
        $export->legalCase?->log('export', 'بسته #'.$export->id.' دانلود شد.', ['export' => $export->id, 'download' => true]);

        return response()->download($path, basename($export->file), [
            'Content-Type' => 'application/zip',
            'Cache-Control' => 'no-store',
        ]);
    }
}
