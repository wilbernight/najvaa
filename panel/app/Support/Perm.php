<?php

namespace App\Support;

use App\Models\User;
use Illuminate\Support\Facades\Gate;

/**
 * Roles and what each may do. Every route and every button checks one of
 * these abilities; the role names are shown in Persian in the team page.
 */
final class Perm
{
    public const ROLES = [
        'owner' => 'مدیر ارشد',
        'legal' => 'مسئول حقوقی',
        'moderator' => 'ناظر محتوا',
        'viewer' => 'فقط مشاهده',
    ];

    public const ABILITIES = [
        'view' => ['owner', 'legal', 'moderator', 'viewer'],
        'rooms.moderate' => ['owner', 'legal', 'moderator'],   // kick, suspend
        'rooms.destroy' => ['owner'],                          // delete room, reset registration
        'legal.view' => ['owner', 'legal'],                     // cases, connection logs
        'legal.manage' => ['owner', 'legal'],                   // cases, hold, watch
        'legal.export' => ['owner', 'legal'],                   // disclosure packages
        'reports.manage' => ['owner', 'legal', 'moderator'],
        'blocks.manage' => ['owner', 'moderator'],
        'notices.manage' => ['owner', 'moderator'],
        'settings.manage' => ['owner'],
        'team.manage' => ['owner'],
        'audit.view' => ['owner', 'legal'],
    ];

    public static function register(): void
    {
        foreach (self::ABILITIES as $ability => $roles) {
            Gate::define($ability, fn (User $u) => $u->isPanelAdmin() && in_array($u->role, $roles, true));
        }
    }

    public static function label(?string $role): string
    {
        return self::ROLES[$role] ?? '—';
    }
}
