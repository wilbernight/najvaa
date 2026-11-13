<?php

use App\Http\Controllers\Panel\AuditController;
use App\Http\Controllers\Panel\BlockController;
use App\Http\Controllers\Panel\CaseController;
use App\Http\Controllers\Panel\DashboardController;
use App\Http\Controllers\Panel\ExportController;
use App\Http\Controllers\Panel\NoticeController;
use App\Http\Controllers\Panel\ReportController;
use App\Http\Controllers\Panel\RoomController;
use App\Http\Controllers\Panel\SettingsController;
use App\Http\Controllers\Panel\StepUpController;
use App\Http\Controllers\Panel\TeamController;
use App\Http\Controllers\Panel\TransparencyController;
use Illuminate\Support\Facades\Route;

// The management panel. Sign-in, two-factor and passkeys stay on Nova's
// pages (NOVA_PATH, /console in production); everything else lives here.
// Every route: signed in + on the admin list + Cloudflare Access identity,
// second factor set up, idle timeout and session binding, strict CSP.
// Sensitive actions additionally need a fresh password + code (panel.stepup).
Route::middleware(['panel.auth', 'najva.2fa', 'panel.session', 'panel.csp'])->name('panel.')->group(function () {
    Route::get('/', [DashboardController::class, 'index'])->name('dashboard');
    Route::get('/pulse', [DashboardController::class, 'pulse'])->name('pulse');

    Route::get('/stepup', [StepUpController::class, 'show'])->name('stepup');
    Route::post('/stepup', [StepUpController::class, 'store'])->middleware('throttle:5,1,stepup.store')->name('stepup.store');

    // Rooms
    Route::get('/rooms', [RoomController::class, 'index'])->name('rooms');
    Route::get('/rooms/find', [RoomController::class, 'find'])->middleware('throttle:30,1,rooms.find')->name('rooms.find');
    Route::get('/rooms/{room:room_id}', [RoomController::class, 'show'])->name('rooms.show');
    Route::middleware(['throttle:30,1,room-actions'])->group(function () {
        Route::post('/rooms/{room:room_id}/kick', [RoomController::class, 'kick'])->middleware('can:rooms.moderate')->name('rooms.kick');
        Route::post('/rooms/{room:room_id}/suspend', [RoomController::class, 'suspend'])->middleware(['can:rooms.moderate', 'panel.stepup'])->name('rooms.suspend');
        Route::post('/rooms/{room:room_id}/unsuspend', [RoomController::class, 'unsuspend'])->middleware(['can:rooms.moderate', 'panel.stepup'])->name('rooms.unsuspend');
        Route::post('/rooms/{room:room_id}/hold', [RoomController::class, 'hold'])->middleware(['can:legal.manage', 'panel.stepup'])->name('rooms.hold');
        Route::post('/rooms/{room:room_id}/release', [RoomController::class, 'release'])->middleware(['can:legal.manage', 'panel.stepup'])->name('rooms.release');
        Route::post('/rooms/{room:room_id}/watch', [RoomController::class, 'watch'])->middleware(['can:legal.manage', 'panel.stepup'])->name('rooms.watch');
        Route::post('/rooms/{room:room_id}/unwatch', [RoomController::class, 'unwatch'])->middleware(['can:legal.manage', 'panel.stepup'])->name('rooms.unwatch');
        Route::post('/rooms/{room:room_id}/reset', [RoomController::class, 'reset'])->middleware(['can:rooms.destroy', 'panel.stepup'])->name('rooms.reset');
        Route::post('/rooms/{room:room_id}/destroy', [RoomController::class, 'destroy'])->middleware(['can:rooms.destroy', 'panel.stepup'])->name('rooms.destroy');
        Route::post('/janitor', [RoomController::class, 'janitor'])->middleware(['can:settings.manage'])->name('janitor');
    });

    // Legal cases
    Route::middleware('can:legal.view')->group(function () {
        Route::get('/cases', [CaseController::class, 'index'])->name('cases');
        Route::get('/cases/new', [CaseController::class, 'create'])->middleware('can:legal.manage')->name('cases.create');
        Route::post('/cases', [CaseController::class, 'store'])->middleware(['can:legal.manage', 'throttle:20,1,cases.store'])->name('cases.store');
        Route::get('/cases/{case}', [CaseController::class, 'show'])->name('cases.show');
        Route::middleware(['can:legal.manage', 'throttle:30,1,case-actions'])->group(function () {
            Route::post('/cases/{case}/update', [CaseController::class, 'update'])->name('cases.update');
            Route::post('/cases/{case}/note', [CaseController::class, 'note'])->name('cases.note');
            Route::post('/cases/{case}/rooms', [CaseController::class, 'attachRoom'])->name('cases.rooms.attach');
            Route::post('/cases/{case}/rooms/{link}/detach', [CaseController::class, 'detachRoom'])->name('cases.rooms.detach');
        });
        Route::post('/cases/{case}/exports', [ExportController::class, 'store'])->middleware(['can:legal.export', 'panel.stepup', 'throttle:6,1,exports.store'])->name('exports.store');
        Route::get('/exports/{export}/download', [ExportController::class, 'download'])->middleware(['can:legal.export', 'panel.stepup', 'throttle:10,1,exports.download'])->name('exports.download');
        Route::get('/transparency', [TransparencyController::class, 'index'])->name('transparency');
        Route::get('/transparency.csv', [TransparencyController::class, 'csv'])->name('transparency.csv');
    });

    // Abuse reports
    Route::get('/reports', [ReportController::class, 'index'])->name('reports');
    Route::get('/reports/{report}', [ReportController::class, 'show'])->name('reports.show');
    Route::post('/reports/{report}', [ReportController::class, 'update'])->middleware(['can:reports.manage', 'throttle:30,1,reports.update'])->name('reports.update');

    // Address blocks and service notices
    Route::get('/blocks', [BlockController::class, 'index'])->name('blocks');
    Route::post('/blocks', [BlockController::class, 'store'])->middleware(['can:blocks.manage', 'panel.stepup', 'throttle:20,1,blocks.store'])->name('blocks.store');
    Route::post('/blocks/{block}/delete', [BlockController::class, 'destroy'])->middleware(['can:blocks.manage', 'panel.stepup'])->name('blocks.destroy');
    Route::get('/notices', [NoticeController::class, 'index'])->name('notices');
    Route::post('/notices', [NoticeController::class, 'store'])->middleware(['can:notices.manage', 'throttle:10,1,notices.store'])->name('notices.store');
    Route::post('/notices/clear', [NoticeController::class, 'clear'])->middleware(['can:notices.manage'])->name('notices.clear');

    // Audit, settings, team
    Route::get('/audit', [AuditController::class, 'index'])->middleware('can:audit.view')->name('audit');
    Route::post('/audit/verify', [AuditController::class, 'verify'])->middleware(['can:audit.view', 'throttle:6,1,audit.verify'])->name('audit.verify');
    Route::get('/audit.csv', [AuditController::class, 'csv'])->middleware(['can:audit.view', 'panel.stepup'])->name('audit.csv');
    Route::get('/settings', [SettingsController::class, 'edit'])->name('settings');
    Route::post('/settings', [SettingsController::class, 'update'])->middleware(['can:settings.manage', 'panel.stepup'])->name('settings.update');
    Route::get('/team', [TeamController::class, 'index'])->middleware('can:team.manage')->name('team');
    Route::post('/team/{user}', [TeamController::class, 'update'])->middleware(['can:team.manage', 'panel.stepup'])->name('team.update');
    Route::post('/team/{user}/sessions', [TeamController::class, 'endSessions'])->middleware(['can:team.manage', 'panel.stepup'])->name('team.sessions');
    Route::post('/logout', [StepUpController::class, 'logout'])->name('logout');
});
