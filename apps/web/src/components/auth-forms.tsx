'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { forgotPasswordSchema, loginSchema, type MeDTO, resetPasswordSchema, signupSchema } from '@okf/shared';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Alert, Field, Input } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';

/** Only same-site relative paths are allowed as post-login redirects (no open redirect). */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/dashboard';
}

function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  return (
    <Alert tone="danger" className="mb-4">
      {e?.message ?? 'Something went wrong.'}
    </Alert>
  );
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [error, setError] = React.useState<unknown>(null);
  const form = useForm<z.input<typeof loginSchema>>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } });
  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const me = await api<MeDTO>('/auth/login', { method: 'POST', body: values });
      qc.setQueryData(['me'], me);
      router.replace(safeNext(params.get('next')));
    } catch (e) {
      setError(e);
    }
  });
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <ErrorAlert error={error} />
      <Field label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
        <Input id="email" type="email" autoComplete="email" {...form.register('email')} aria-invalid={!!form.formState.errors.email} />
      </Field>
      <Field label="Password" htmlFor="password" error={form.formState.errors.password?.message}>
        <Input id="password" type="password" autoComplete="current-password" {...form.register('password')} />
      </Field>
      <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
      </Button>
      <div className="flex justify-between text-sm">
        <Link href="/forgot-password" className="text-muted-foreground hover:text-foreground">
          Forgot password?
        </Link>
        <Link href={`/signup${params.get('next') ? `?next=${encodeURIComponent(params.get('next')!)}` : ''}`} className="text-primary">
          Create account
        </Link>
      </div>
    </form>
  );
}

export function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [error, setError] = React.useState<unknown>(null);
  const form = useForm<z.input<typeof signupSchema>>({ resolver: zodResolver(signupSchema), defaultValues: { name: '', email: '', password: '' } });
  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const me = await api<MeDTO>('/auth/signup', { method: 'POST', body: values });
      qc.setQueryData(['me'], me);
      router.replace(params.get('next') ? safeNext(params.get('next')) : '/organizations?welcome=1');
    } catch (e) {
      setError(e);
    }
  });
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <h1 className="text-xl font-semibold">Create your account</h1>
      <ErrorAlert error={error} />
      <Field label="Name" htmlFor="name" error={form.formState.errors.name?.message}>
        <Input id="name" autoComplete="name" {...form.register('name')} />
      </Field>
      <Field label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
        <Input id="email" type="email" autoComplete="email" {...form.register('email')} />
      </Field>
      <Field label="Password" htmlFor="password" error={form.formState.errors.password?.message} hint="At least 12 characters. A passphrase works well.">
        <Input id="password" type="password" autoComplete="new-password" {...form.register('password')} />
      </Field>
      <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? 'Creating account…' : 'Create account'}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link href="/login" className="text-primary">
          Sign in
        </Link>
      </p>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const form = useForm<z.input<typeof forgotPasswordSchema>>({ resolver: zodResolver(forgotPasswordSchema), defaultValues: { email: '' } });
  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: values });
      setSent(true);
    } catch (e) {
      setError(e);
    }
  });
  if (sent) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">Check your email</h1>
        <p className="text-sm text-muted-foreground">If an account exists for that address, we sent a link to reset the password. It expires in one hour.</p>
        <Link href="/login" className="text-sm text-primary">
          Back to sign in
        </Link>
      </div>
    );
  }
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <h1 className="text-xl font-semibold">Reset your password</h1>
      <ErrorAlert error={error} />
      <Field label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
        <Input id="email" type="email" autoComplete="email" {...form.register('email')} />
      </Field>
      <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
        Send reset link
      </Button>
    </form>
  );
}

export function ResetPasswordForm() {
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = React.useState<unknown>(null);
  const form = useForm<z.input<typeof resetPasswordSchema>>({ resolver: zodResolver(resetPasswordSchema), defaultValues: { token: params.get('token') ?? '', password: '' } });
  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api('/auth/reset-password', { method: 'POST', body: values });
      router.replace('/login?reset=1');
    } catch (e) {
      setError(e);
    }
  });
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <h1 className="text-xl font-semibold">Choose a new password</h1>
      <ErrorAlert error={error} />
      {form.formState.errors.token ? <Alert tone="danger">This reset link is incomplete. Request a new one.</Alert> : null}
      <Field label="New password" htmlFor="password" error={form.formState.errors.password?.message} hint="All other sessions will be signed out.">
        <Input id="password" type="password" autoComplete="new-password" {...form.register('password')} />
      </Field>
      <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
        Update password
      </Button>
    </form>
  );
}
