<?php

namespace App\Http\Controllers\Panel;

use App\Http\Controllers\Controller;
use App\Models\AdminLog;
use App\Models\User;
use App\Support\Perm;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

/**
 * Roles of the panel accounts. Accounts are created over SSH
 * (`php artisan nova:user`), and only e-mails in NAJVA_ADMINS get in at all.
 */
class TeamController extends Controller
{
    public function index()
    {
        $users = User::query()->withCount('passkeys')->orderBy('name')->get();
        $sessions = config('session.driver') === 'database'
            ? DB::table(config('session.table', 'sessions'))->select('user_id', DB::raw('count(*) as n'), DB::raw('max(last_activity) as last'))->whereNotNull('user_id')->groupBy('user_id')->get()->keyBy('user_id')
            : collect();

        return view('panel.team', ['users' => $users, 'sessions' => $sessions]);
    }

    public function update(Request $request, User $user)
    {
        $role = (string) $request->validate(['role' => ['required', Rule::in(array_keys(Perm::ROLES))]])['role'];
        if ($user->role === 'owner' && $role !== 'owner' && User::query()->where('role', 'owner')->count() <= 1) {
            return back()->withErrors(['role' => 'دست‌کم یک مدیر ارشد باید بماند.']);
        }
        $from = $user->role;
        $user->forceFill(['role' => $role])->save();
        AdminLog::record('team.role', $user->email, ['from' => $from, 'to' => $role]);

        return back()->with('panel.flash', 'نقش '.$user->name.' به «'.Perm::label($role).'» تغییر کرد.');
    }

    /** Signs an account out everywhere (all its sessions are deleted). */
    public function endSessions(User $user)
    {
        if (config('session.driver') === 'database') {
            DB::table(config('session.table', 'sessions'))->where('user_id', $user->id)
                ->when($user->is(auth()->user()), fn ($q) => $q->where('id', '!=', session()->getId()))
                ->delete();
        }
        $user->forceFill(['remember_token' => null])->save();
        AdminLog::record('team.sessions.ended', $user->email);

        return back()->with('panel.flash', 'همه‌ی نشست‌های '.$user->name.' بسته شد.');
    }
}
