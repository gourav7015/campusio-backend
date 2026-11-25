/** The seats a staff member can fill on a bus: the one their job title carries (Driver, Conductor), plus any they have been marked "can also" do. */
export const busRolesOf = (designation, staff) => [...new Set([designation?.busRole, ...(staff?.alsoBusRoles || [])].filter(Boolean))];
