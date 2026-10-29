import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSupabaseConfig } from './supabase';

test('validateSupabaseConfig rejects empty or placeholder values without exposing secrets', () => {
  const emptyResult = validateSupabaseConfig('', '');
  assert.equal(emptyResult.isConfigured, false);
  assert.equal(emptyResult.hasValidUrlFormat, false);

  const placeholderResult = validateSupabaseConfig(
    'https://your-project-id.supabase.co',
    'your-supabase-anon-key'
  );
  assert.equal(placeholderResult.isConfigured, false);
});

test('validateSupabaseConfig blocks accidental service_role or secret keys on frontend', () => {
  const secretKeyAttempt = validateSupabaseConfig(
    'https://exampleproject.supabase.co',
    'sb_secret_1234567890abcdef'
  );
  assert.equal(secretKeyAttempt.isConfigured, false);
  assert.equal(secretKeyAttempt.isSafePublicKey, false);
});

test('validateSupabaseConfig accepts valid HTTPS URL and public anon/publishable key without leaking values', () => {
  const sampleUrl = 'https://exampleproject.supabase.co';
  const sampleAnon = 'sb_publishable_1234567890abcdefghijklmnop';
  const validResult = validateSupabaseConfig(sampleUrl, sampleAnon);

  assert.equal(validResult.isConfigured, true);
  assert.equal(validResult.hasValidUrlFormat, true);
  assert.equal(validResult.hasAnonKey, true);
  assert.equal(validResult.isSafePublicKey, true);
  // Ensure the reason summary never contains the raw URL or key
  assert.equal(validResult.reason.includes(sampleUrl), false);
  assert.equal(validResult.reason.includes(sampleAnon), false);
});
