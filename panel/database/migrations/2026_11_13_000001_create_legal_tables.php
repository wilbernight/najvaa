<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Legal response and moderation: roles, cases, holds, reports, address
 * blocks, service notices, disclosure exports, and a hash-chained audit log.
 * Free text that may name people (case notes, reports) is stored encrypted
 * with the app key.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            // owner | legal | moderator | viewer (see App\Support\Perm)
            $table->string('role', 20)->default('viewer')->after('email');
            $table->timestamp('last_login_at')->nullable();
            $table->string('last_login_ip', 64)->nullable();
        });
        // Whoever already had an account set the panel up: keep full access.
        DB::table('users')->update(['role' => 'owner']);

        Schema::table('najva_rooms', function (Blueprint $table) {
            $table->boolean('hold')->default(false)->index();
            $table->boolean('suspended')->default(false)->index();
            $table->timestamp('watch_until')->nullable();
            $table->unsignedInteger('held_items')->default(0);
            $table->json('flags')->nullable();
        });

        Schema::create('legal_cases', function (Blueprint $table) {
            $table->id();
            $table->string('ref', 30)->unique();               // internal number, e.g. NJ-1405-0007
            $table->string('kind', 20);                         // preservation | disclosure | takedown | suspension | monitoring | info
            $table->string('status', 20)->default('received'); // received | review | in_progress | fulfilled | partial | rejected | closed
            $table->string('priority', 10)->default('normal');  // low | normal | high | urgent
            $table->text('authority');                          // encrypted: the requesting body
            $table->text('authority_ref')->nullable();          // encrypted: their letter / order number
            $table->text('subject');                            // encrypted
            $table->text('description')->nullable();            // encrypted
            $table->date('received_on');
            $table->date('due_on')->nullable();
            $table->foreignId('assignee_id')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamp('closed_at')->nullable();
            $table->timestamps();
            $table->index(['status', 'due_on']);
        });

        Schema::create('legal_case_rooms', function (Blueprint $table) {
            $table->id();
            $table->foreignId('legal_case_id')->constrained()->cascadeOnDelete();
            $table->string('room_id', 32)->index();
            $table->string('code', 7)->nullable();
            $table->foreignId('added_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
            $table->unique(['legal_case_id', 'room_id']);
        });

        Schema::create('case_events', function (Blueprint $table) {
            $table->id();
            $table->foreignId('legal_case_id')->constrained()->cascadeOnDelete();
            $table->foreignId('user_id')->nullable()->constrained()->nullOnDelete();
            $table->string('kind', 30);   // note | status | room | hold | release | suspend | unsuspend | watch | unwatch | export | report
            $table->text('body')->nullable(); // encrypted
            $table->json('meta')->nullable();
            $table->timestamp('created_at')->index();
        });

        Schema::create('abuse_reports', function (Blueprint $table) {
            $table->id();
            $table->string('remote_id', 20)->unique();
            $table->string('room_id', 32)->index();
            $table->string('code', 7)->index();
            $table->string('reason', 20);
            $table->text('body')->nullable();     // encrypted
            $table->text('contact')->nullable();  // encrypted
            $table->string('status', 20)->default('new')->index(); // new | reviewing | actioned | dismissed
            $table->foreignId('legal_case_id')->nullable()->constrained()->nullOnDelete();
            $table->foreignId('handled_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamp('handled_at')->nullable();
            $table->text('resolution')->nullable(); // encrypted
            $table->timestamp('received_at')->index();
            $table->timestamps();
        });

        Schema::create('ip_blocks', function (Blueprint $table) {
            $table->id();
            $table->string('cidr', 64)->unique();
            $table->string('note', 200)->nullable();
            $table->timestamp('until')->nullable();
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });

        Schema::create('service_notices', function (Blueprint $table) {
            $table->id();
            $table->string('text', 500);
            $table->string('level', 10)->default('info');
            $table->timestamp('until')->nullable();
            $table->unsignedInteger('sent_to')->default(0);
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamp('cleared_at')->nullable();
            $table->timestamps();
        });

        Schema::create('disclosure_exports', function (Blueprint $table) {
            $table->id();
            $table->foreignId('legal_case_id')->constrained()->cascadeOnDelete();
            $table->string('room_id', 32);
            $table->string('code', 7)->nullable();
            $table->boolean('with_content')->default(false);
            $table->string('file', 200)->nullable();
            $table->unsignedBigInteger('bytes')->default(0);
            $table->string('sha256', 64)->nullable();
            $table->string('signature', 64)->nullable();
            $table->unsignedInteger('items')->default(0);
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->unsignedInteger('downloads')->default(0);
            $table->timestamp('expires_at')->nullable();
            $table->timestamp('purged_at')->nullable();
            $table->timestamps();
        });

        Schema::table('admin_logs', function (Blueprint $table) {
            $table->string('ua', 200)->nullable();
            $table->char('prev_hash', 64)->nullable();
            $table->char('hash', 64)->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('admin_logs', fn (Blueprint $t) => $t->dropColumn(['ua', 'prev_hash', 'hash']));
        Schema::dropIfExists('disclosure_exports');
        Schema::dropIfExists('service_notices');
        Schema::dropIfExists('ip_blocks');
        Schema::dropIfExists('abuse_reports');
        Schema::dropIfExists('case_events');
        Schema::dropIfExists('legal_case_rooms');
        Schema::dropIfExists('legal_cases');
        Schema::table('najva_rooms', fn (Blueprint $t) => $t->dropColumn(['hold', 'suspended', 'watch_until', 'held_items', 'flags']));
        Schema::table('users', fn (Blueprint $t) => $t->dropColumn(['role', 'last_login_at', 'last_login_ip']));
    }
};
