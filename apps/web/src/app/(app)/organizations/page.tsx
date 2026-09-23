'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { createOrgSchema, type OrgDTO } from '@okf/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, Field, Input } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useCurrentOrg, useRequireAuth } from '@/lib/session';

function CreateOrg() {
  const qc = useQueryClient();
  const { setOrg } = useCurrentOrg();
  const form = useForm<z.input<typeof createOrgSchema>>({ resolver: zodResolver(createOrgSchema), defaultValues: { name: '' } });
  const create = useMutation({
    mutationFn: (v: z.input<typeof createOrgSchema>) => api<OrgDTO>('/organizations', { method: 'POST', body: v }),
    onSuccess: async (org) => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['organizations'] });
      setOrg(org.id);
      form.reset();
      toast.success(`Created ${org.name}`);
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>New organization</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="flex flex-col gap-3 sm:flex-row sm:items-end" noValidate>
          <div className="flex-1">
            <Field label="Name" htmlFor="org-name" error={form.formState.errors.name?.message}>
              <Input id="org-name" placeholder="Acme Data" {...form.register('name')} />
            </Field>
          </div>
          <Button type="submit" disabled={create.isPending}>
            <Plus /> Create organization
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function OrganizationsInner() {
  useRequireAuth();
  const params = useSearchParams();
  const orgs = useQuery({ queryKey: ['organizations'], queryFn: () => api<{ data: OrgDTO[] }>('/organizations') });
  return (
    <>
      <PageHeader title="Organizations" description="Datasets, members, API keys and audit logs are scoped to an organization." />
      {params.get('welcome') ? (
        <Alert tone="success" title="Account created" className="mb-4">
          Create an organization to start cataloguing OKF bundles, or accept an invitation from a teammate.
        </Alert>
      ) : null}
      <div className="space-y-6">
        <CreateOrg />
        {orgs.isLoading ? (
          <LoadingRows rows={2} />
        ) : orgs.error ? (
          <ErrorState error={orgs.error} />
        ) : orgs.data!.data.length === 0 ? (
          <EmptyState icon={Building2} title="You are not a member of any organization yet" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {orgs.data!.data.map((o) => (
              <Link key={o.id} href={`/organizations/${o.id}`} className="rounded-lg border bg-card p-4 hover:border-primary/50">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{o.name}</span>
                  <Badge tone={o.role === 'owner' ? 'primary' : 'default'}>{o.role}</Badge>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {o.datasetCount} datasets · {o.memberCount} members
                </p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export default function OrganizationsPage() {
  return (
    <Suspense>
      <OrganizationsInner />
    </Suspense>
  );
}
