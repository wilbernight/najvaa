<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Snapshot of the relay's rooms: sizes, counts and times only.
        Schema::create('najva_rooms', function (Blueprint $table) {
            $table->id();
            $table->string('room_id', 32)->unique();
            $table->unsignedBigInteger('bytes')->default(0);
            $table->unsignedInteger('items')->default(0);
            $table->unsignedInteger('files')->default(0);
            $table->unsignedTinyInteger('online')->default(0);
            $table->boolean('stored')->default(false);
            $table->timestamp('remote_created_at')->nullable();
            $table->timestamp('last_activity_at')->nullable();
            $table->timestamps();
        });

        // One row per sync, for the dashboard trends.
        Schema::create('najva_metrics', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('total_bytes')->default(0);
            $table->unsignedBigInteger('cap_bytes')->default(0);
            $table->unsignedInteger('stored_rooms')->default(0);
            $table->unsignedInteger('live_rooms')->default(0);
            $table->unsignedInteger('devices')->default(0);
            $table->unsignedBigInteger('relay_rss')->default(0);
            $table->timestamp('created_at')->index();
        });

        Schema::create('najva_settings', function (Blueprint $table) {
            $table->id();
            $table->unsignedSmallInteger('cap_gb')->default(50);
            $table->unsignedSmallInteger('max_days')->default(90);
            $table->boolean('gif')->default(true);
            $table->boolean('preview')->default(true);
            $table->boolean('calls')->default(true);
            $table->boolean('new_rooms')->default(true);
            $table->timestamps();
        });

        Schema::create('najva_service_checks', function (Blueprint $table) {
            $table->id();
            $table->string('key', 40)->unique();
            $table->string('name', 80);
            $table->string('status', 10);   // ok | warn | down
            $table->string('detail', 255)->nullable();
            $table->timestamp('checked_at')->nullable();
            $table->timestamps();
        });

        Schema::create('najva_domains', function (Blueprint $table) {
            $table->id();
            $table->string('zone_id', 40)->unique();
            $table->string('name', 120);
            $table->string('status', 20)->nullable();
            $table->string('ssl_mode', 20)->nullable();
            $table->string('always_https', 5)->nullable();
            $table->string('min_tls', 5)->nullable();
            $table->unsignedSmallInteger('aaaa_records')->default(0);
            $table->unsignedSmallInteger('aaaa_proxied')->default(0);
            $table->unsignedSmallInteger('aaaa_stale')->default(0);
            $table->timestamp('synced_at')->nullable();
            $table->timestamps();
        });

        // What admins did: logins, failed logins, settings changes, deletions.
        Schema::create('admin_logs', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->nullable()->constrained()->nullOnDelete();
            $table->string('email', 191)->nullable();
            $table->string('action', 60)->index();
            $table->string('target', 120)->nullable();
            $table->json('detail')->nullable();
            $table->string('ip', 64)->nullable();
            $table->timestamp('created_at')->index();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('admin_logs');
        Schema::dropIfExists('najva_domains');
        Schema::dropIfExists('najva_service_checks');
        Schema::dropIfExists('najva_settings');
        Schema::dropIfExists('najva_metrics');
        Schema::dropIfExists('najva_rooms');
    }
};
