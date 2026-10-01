export interface SignupCapacity {
  configured: boolean;
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
  timezone: string;
  scope: string;
}
export interface AdminDashboardData {
  summary: {day:string;timezone:string;limit:number;used:number;remaining:number;registrations:number;signIns:number;uniqueSignIns:number;accepted?:number;failed?:number;uncertain?:number};
  users: Array<{id:string;email:string;emailVerified:boolean;createdAt:string;lastSignIn:string|null;signInCount:number}>;
  signIns: Array<{id:string|number;email:string;occurredAt:string;kind:'password'|'verification'}>;
  pagination: {page:number;pageSize:number;totalUsers:number;totalSignIns:number};
}
