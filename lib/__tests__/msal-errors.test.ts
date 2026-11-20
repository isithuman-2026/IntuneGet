import { describe, expect, it } from 'vitest';
import { isNotAssignedError } from '../msal-errors';

describe('isNotAssignedError', () => {
  it('matches the error code', () => {
    expect(isNotAssignedError({ errorCode: 'AADSTS50105' })).toBe(true);
  });
  it('matches the code inside the message', () => {
    expect(isNotAssignedError({ message: 'AADSTS50105: The signed in user ...' })).toBe(true);
  });
  it('ignores other errors', () => {
    expect(isNotAssignedError(new Error('user_cancelled'))).toBe(false);
  });
  it('ignores null', () => {
    expect(isNotAssignedError(null)).toBe(false);
  });
});
