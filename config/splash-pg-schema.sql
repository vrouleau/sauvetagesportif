-- Splash Meet Manager's own Postgres schema
-- Captured with pg_dump from an empty database created by real Splash Meet Manager 11
-- (build 11.85709, 2026-11-20). meet-app runs this when it connects to a Postgres database that
-- has no tables yet, so the database is the same as one Splash created itself (exact types,
-- defaults, keys, indexes, sequences) and Splash can open it. Regenerate from a fresh database
-- Splash has connected to, after a Splash upgrade (see packages/meet-app/CLAUDE.md).
-- Multi-line values keep Splash's CRLF line breaks - keep this file's bytes as they are.

CREATE TABLE public.agegroup (
    agegroupid integer NOT NULL,
    agebytotal character(1) DEFAULT 'F'::bpchar,
    agemax smallint,
    agemax2 smallint,
    agemin smallint,
    agemin2 smallint,
    allofficial character(1) DEFAULT 'F'::bpchar,
    athletestatuses integer,
    clubids character varying(1024),
    code character varying(10),
    externalid character varying(40),
    fastheatcount smallint,
    forceprelim character(1) DEFAULT 'F'::bpchar,
    gender smallint,
    handicaps character varying(100),
    heatcount smallint,
    heatqualipriority character varying(50),
    levelmax character varying(5),
    levelmin character varying(5),
    name character varying(50),
    nationality character varying(3),
    nationregions character varying(1024),
    resultcount smallint,
    scoretype smallint,
    seedwithtsonly character(1) DEFAULT 'F'::bpchar,
    sortcode integer,
    swimeventid integer,
    swimlevels character varying(255),
    useformedals character(1) DEFAULT 'F'::bpchar,
    useforscoring character(1) DEFAULT 'F'::bpchar,
    winnertitle character varying(100),
    foreigncount smallint,
    finalseedtype smallint,
    afinal8lanes character(1) DEFAULT 'F'::bpchar,
    agegroupguid uuid,
    syncmodified integer,
    isdirty character(1) DEFAULT 'F'::bpchar,
    CONSTRAINT agegroup_afinal8lanes_check CHECK ((afinal8lanes = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT agegroup_agebytotal_check CHECK ((agebytotal = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT agegroup_allofficial_check CHECK ((allofficial = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT agegroup_forceprelim_check CHECK ((forceprelim = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT agegroup_isdirty_check CHECK ((isdirty = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT agegroup_seedwithtsonly_check CHECK ((seedwithtsonly = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT agegroup_useformedals_check CHECK ((useformedals = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT agegroup_useforscoring_check CHECK ((useforscoring = ANY (ARRAY['F'::bpchar, 'T'::bpchar])))
);

CREATE TABLE public.athlete (
    athleteid integer NOT NULL,
    clubid integer,
    firstname character varying(30),
    firstname_upper character varying(5),
    gender smallint,
    lastname character varying(50),
    lastname_upper character varying(10),
    nameprefix character varying(20),
    birthdate timestamp without time zone,
    domicile character varying(50),
    externalid character varying(40),
    firstnameen character varying(30),
    handicapex character varying(20),
    handicaps smallint,
    handicapsb smallint,
    handicapsm smallint,
    lastnameen character varying(50),
    license character varying(20),
    nation character varying(3),
    sdmsid integer,
    status integer,
    swimlevel character varying(10),
    swrid integer,
    swrhashkey integer,
    clubcode2 character varying(10),
    coachname character varying(80),
    schoolyear character varying(10),
    middlename character varying(50),
    middlenameen character varying(50),
    athleteguid uuid,
    syncmodified integer,
    isdirty character(1) DEFAULT 'F'::bpchar,
    CONSTRAINT athlete_isdirty_check CHECK ((isdirty = ANY (ARRAY['F'::bpchar, 'T'::bpchar])))
);

CREATE TABLE public.biography (
    biographyid integer NOT NULL,
    xmldata text,
    imageformat smallint,
    picture bytea
);

CREATE TABLE public.bsglobal (
    name character varying(50) DEFAULT ''::character varying NOT NULL,
    data text
);

CREATE TABLE public.bsmessage (
    bsmessageid integer NOT NULL,
    created timestamp without time zone,
    data character varying(2048)
);

CREATE SEQUENCE public.bsmessage_bsmessageid_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.bsmessage_bsmessageid_seq OWNED BY public.bsmessage.bsmessageid;

CREATE TABLE public.bspicture (
    bspictureid integer NOT NULL,
    code character varying(100),
    comment character varying(255),
    imageformat integer,
    picture bytea,
    height integer,
    width integer
);

CREATE TABLE public.bsswkatalogitem (
    bsswkatalogitemid integer NOT NULL,
    code character varying(10),
    itemid smallint,
    katalogid integer,
    lenexcode character varying(10),
    name character varying(250),
    sortcode smallint
);

CREATE TABLE public.club (
    clubid integer NOT NULL,
    bonuspoints integer,
    clubtype smallint,
    code character varying(10),
    contactname character varying(50),
    contactinternet character varying(150),
    contactcity character varying(30),
    contactcountry character varying(2),
    contactemail character varying(50),
    contactfax character varying(20),
    contactphone character varying(20),
    contactstate character varying(5),
    contactstreet character varying(50),
    contactstreet2 character varying(50),
    contactzip character varying(10),
    externalid character varying(40),
    longcode character varying(20),
    entryclubid integer,
    entryemails character varying(255),
    name character varying(80),
    nameen character varying(80),
    nation character varying(3),
    region character varying(10),
    shortname character varying(30),
    shortnameen character varying(30),
    swrid integer,
    teamnumber smallint,
    clubguid uuid,
    syncmodified integer,
    isdirty character(1) DEFAULT 'F'::bpchar,
    CONSTRAINT club_isdirty_check CHECK ((isdirty = ANY (ARRAY['F'::bpchar, 'T'::bpchar])))
);

CREATE TABLE public.coach (
    coachid integer NOT NULL,
    clubid integer,
    firstname character varying(30),
    firstname_upper character varying(5),
    gender smallint,
    lastname character varying(50),
    lastname_upper character varying(10),
    nameprefix character varying(20),
    contactcity character varying(30),
    contactcountry character varying(2),
    contactemail character varying(50),
    contactfax character varying(20),
    contactphone character varying(20),
    contactstate character varying(5),
    contactstreet character varying(50),
    contactstreet2 character varying(50),
    contactzip character varying(10),
    coachtype smallint,
    license character varying(20),
    nation character varying(3),
    coachguid uuid,
    syncmodified integer,
    isdirty character(1) DEFAULT 'F'::bpchar,
    CONSTRAINT coach_isdirty_check CHECK ((isdirty = ANY (ARRAY['F'::bpchar, 'T'::bpchar])))
);

CREATE TABLE public.dsqitem (
    dsqitemid integer NOT NULL,
    code character varying(10),
    lenexcode character varying(10),
    name character varying(250),
    options character varying(5),
    sortcode smallint
);

CREATE TABLE public.eventrecord (
    eventrecordid integer NOT NULL,
    swimeventid integer,
    listid integer,
    comment character varying(50),
    fine double precision,
    marker character varying(8),
    onresultlist character(1) DEFAULT 'F'::bpchar,
    onstartlist character(1) DEFAULT 'F'::bpchar,
    sortcode integer,
    CONSTRAINT eventrecord_onresultlist_check CHECK ((onresultlist = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT eventrecord_onstartlist_check CHECK ((onstartlist = ANY (ARRAY['F'::bpchar, 'T'::bpchar])))
);

CREATE SEQUENCE public.gen_bs_global_uid
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE SEQUENCE public.gen_layout
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.heat (
    heatid integer NOT NULL,
    agegroupid integer,
    agegrouporder integer,
    daytime timestamp without time zone,
    finalcode character varying(2),
    heatnumber smallint,
    racestatus smallint,
    remarks text,
    sortcode integer,
    swimeventid integer,
    name character varying(50),
    seedeventid integer,
    code character varying(10),
    reservecount smallint,
    foreigncount smallint
);

CREATE TABLE public.judge (
    judgeid integer NOT NULL,
    judgenumber smallint,
    officialid integer,
    judgerole smallint,
    remarks character varying(100),
    sortcode integer,
    swimsessionid integer
);

CREATE TABLE public.official (
    officialid integer NOT NULL,
    clubid integer,
    firstname character varying(30),
    firstname_upper character varying(5),
    gender smallint,
    lastname character varying(50),
    lastname_upper character varying(10),
    nameprefix character varying(20),
    contactcity character varying(30),
    contactcountry character varying(2),
    contactemail character varying(50),
    contactfax character varying(20),
    contactphone character varying(20),
    contactstate character varying(5),
    contactstreet character varying(50),
    contactstreet2 character varying(50),
    contactzip character varying(10),
    grade character varying(20),
    license character varying(20),
    officialguid uuid,
    syncmodified integer,
    isdirty character(1) DEFAULT 'F'::bpchar,
    CONSTRAINT official_isdirty_check CHECK ((isdirty = ANY (ARRAY['F'::bpchar, 'T'::bpchar])))
);

CREATE TABLE public.record (
    recordid integer NOT NULL,
    recordlistid integer,
    recordagegroupid integer,
    agegroup integer,
    birthdate timestamp without time zone,
    clubcode character varying(10),
    clubname character varying(80),
    clubnation character varying(3),
    course smallint,
    firstname character varying(30),
    gender smallint,
    handicap smallint,
    lastname character varying(50),
    meetcity character varying(30),
    meetdate timestamp without time zone,
    meetname character varying(100),
    meetnation character varying(3),
    nameprefix character varying(20),
    resultid integer,
    swimeventid integer,
    swimstyleid integer,
    swimtime integer
);

CREATE TABLE public.recordagegroup (
    recordagegroupid integer NOT NULL,
    agemax smallint,
    agemin smallint,
    agetype smallint
);

CREATE TABLE public.recordlist (
    recordlistid integer NOT NULL,
    agegroups character varying(255),
    code character varying(20),
    lenexcode character varying(20),
    name character varying(100),
    nationregion character varying(20),
    shortname character varying(40),
    sortcode integer,
    splashmecode character varying(10),
    updatemode smallint,
    agecacltype smallint
);

CREATE TABLE public.recordlistagegroup (
    recordlistid integer,
    recordagegroupid integer
);

CREATE TABLE public.recordposition (
    birthdate timestamp without time zone,
    firstname character varying(30),
    gender smallint,
    lastname character varying(50),
    nameprefix character varying(20),
    recordid integer,
    relaynumber smallint
);

CREATE TABLE public.recordsplit (
    recordid integer NOT NULL,
    distance smallint NOT NULL,
    swimtime integer
);

CREATE TABLE public.relay (
    relayid integer NOT NULL,
    agemax smallint,
    agemin smallint,
    agetotal smallint,
    athletes integer,
    clubid integer,
    gender smallint,
    name character varying(100),
    relaycode integer,
    teamnumber smallint,
    agegroupid integer,
    backuptime1 integer,
    backuptime2 integer,
    backuptime3 integer,
    bonusentry character(1) DEFAULT 'F'::bpchar,
    comment character varying(250),
    dsqitemid integer,
    dsqdaytime timestamp without time zone,
    dsqnotified character(1) DEFAULT 'F'::bpchar,
    dsqnumber smallint,
    entrycourse smallint,
    entrytime integer,
    finalfix character(1) DEFAULT 'F'::bpchar,
    finishjudge smallint,
    heatid integer,
    infocode character varying(5),
    lane smallint,
    lateentry character(1) DEFAULT 'F'::bpchar,
    mpoints smallint,
    padtime integer,
    qtcity character varying(30),
    qtcourse smallint,
    qtdate timestamp without time zone,
    qtname character varying(100),
    qtnation character varying(3),
    qttime integer,
    qualcode character varying(2),
    reactiontime smallint,
    resultstatus smallint,
    swimeventid integer,
    swimtime integer,
    usetimetype smallint,
    dsqofficialid integer,
    reservecode character varying(20),
    noadvance character(1) DEFAULT 'F'::bpchar,
    officialsplits character varying(100),
    qttiming smallint,
    relayguid uuid,
    syncmodified integer,
    isdirty character(1) DEFAULT 'F'::bpchar,
    CONSTRAINT relay_bonusentry_check CHECK ((bonusentry = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT relay_dsqnotified_check CHECK ((dsqnotified = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT relay_finalfix_check CHECK ((finalfix = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT relay_isdirty_check CHECK ((isdirty = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT relay_lateentry_check CHECK ((lateentry = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT relay_noadvance_check CHECK ((noadvance = ANY (ARRAY['F'::bpchar, 'T'::bpchar])))
);

CREATE TABLE public.relayposition (
    athleteid integer,
    qtcity character varying(30),
    qtcourse smallint,
    qtdate timestamp without time zone,
    qtname character varying(100),
    qtnation character varying(3),
    qttime integer,
    qtislap character(1) DEFAULT 'F'::bpchar,
    reactiontime smallint,
    relayid integer,
    relaynumber smallint,
    resultstatus smallint,
    qttiming smallint,
    CONSTRAINT relayposition_qtislap_check CHECK ((qtislap = ANY (ARRAY['F'::bpchar, 'T'::bpchar])))
);

CREATE TABLE public.relaysplit (
    relayid integer NOT NULL,
    distance smallint NOT NULL,
    swimtime integer
);

CREATE TABLE public.resultplace (
    agegroupid integer NOT NULL,
    fjeffective smallint,
    place smallint,
    resultid integer,
    sortcode smallint NOT NULL
);

CREATE TABLE public.resultpointscore (
    resultid integer,
    pointscoreid integer
);

CREATE TABLE public.splashmemessage (
    splashmemessageid integer NOT NULL,
    data text,
    destination integer,
    email character varying(60),
    handled character(1) DEFAULT 'F'::bpchar,
    modified timestamp without time zone,
    typ smallint,
    swrid integer,
    CONSTRAINT splashmemessage_handled_check CHECK ((handled = ANY (ARRAY['F'::bpchar, 'T'::bpchar])))
);

CREATE TABLE public.split (
    swimresultid integer NOT NULL,
    distance smallint NOT NULL,
    swimtime integer
);

CREATE TABLE public.swimevent (
    swimeventid integer NOT NULL,
    comment text,
    daytime timestamp without time zone,
    duration timestamp without time zone,
    entrytimeconversion smallint,
    entrytimepercent smallint,
    eventnumber smallint,
    externalid character varying(40),
    fee double precision,
    finalorder smallint,
    gender smallint,
    lanemax smallint,
    lytentrylist integer,
    lytstartlist integer,
    lytresult2column integer,
    lytresult2split integer,
    lytresult4split integer,
    lytresultnosplit integer,
    lytresulthtml integer,
    masters character(1) DEFAULT 'F'::bpchar,
    maxentries smallint,
    pfineignore character(1) DEFAULT 'F'::bpchar,
    preveventid integer,
    qualbyplace smallint,
    round smallint,
    seedbonuslast character(1) DEFAULT 'F'::bpchar,
    seedexhlast character(1) DEFAULT 'F'::bpchar,
    seedlateentrylast character(1) DEFAULT 'F'::bpchar,
    seedingglobal character(1) DEFAULT 'F'::bpchar,
    singleheats smallint,
    sortcode integer,
    splashmecanedit character(1) DEFAULT 'F'::bpchar,
    sponsor character varying(50),
    swimsessionid integer,
    swimstyleid integer,
    twoperlane character(1) DEFAULT 'F'::bpchar,
    roundname character varying(50),
    combineagegroups character(1) DEFAULT 'F'::bpchar,
    roundone character varying(20),
    internalevent character(1) DEFAULT 'F'::bpchar,
    swimeventguid uuid,
    syncmodified integer,
    isdirty character(1) DEFAULT 'F'::bpchar,
    starttimeeff timestamp without time zone,
    officialat timestamp without time zone,
    revised timestamp without time zone,
    CONSTRAINT swimevent_combineagegroups_check CHECK ((combineagegroups = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT swimevent_internalevent_check CHECK ((internalevent = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT swimevent_isdirty_check CHECK ((isdirty = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT swimevent_masters_check CHECK ((masters = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT swimevent_pfineignore_check CHECK ((pfineignore = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT swimevent_seedbonuslast_check CHECK ((seedbonuslast = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT swimevent_seedexhlast_check CHECK ((seedexhlast = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT swimevent_seedingglobal_check CHECK ((seedingglobal = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT swimevent_seedlateentrylast_check CHECK ((seedlateentrylast = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT swimevent_splashmecanedit_check CHECK ((splashmecanedit = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT swimevent_twoperlane_check CHECK ((twoperlane = ANY (ARRAY['F'::bpchar, 'T'::bpchar])))
);

CREATE TABLE public.swimresult (
    swimresultid integer NOT NULL,
    athleteid integer,
    swrabestid integer,
    swrabesttime integer,
    swrsbestid integer,
    swrsbesttime integer,
    agegroupid integer,
    backuptime1 integer,
    backuptime2 integer,
    backuptime3 integer,
    bonusentry character(1) DEFAULT 'F'::bpchar,
    comment character varying(250),
    dsqitemid integer,
    dsqdaytime timestamp without time zone,
    dsqnotified character(1) DEFAULT 'F'::bpchar,
    dsqnumber smallint,
    entrycourse smallint,
    entrytime integer,
    finalfix character(1) DEFAULT 'F'::bpchar,
    finishjudge smallint,
    heatid integer,
    infocode character varying(5),
    lane smallint,
    lateentry character(1) DEFAULT 'F'::bpchar,
    mpoints smallint,
    padtime integer,
    qtcity character varying(30),
    qtcourse smallint,
    qtdate timestamp without time zone,
    qtname character varying(100),
    qtnation character varying(3),
    qttime integer,
    qualcode character varying(2),
    reactiontime smallint,
    resultstatus smallint,
    swimeventid integer,
    swimtime integer,
    usetimetype smallint,
    dsqofficialid integer,
    reservecode character varying(20),
    noadvance character(1) DEFAULT 'F'::bpchar,
    officialsplits character varying(100),
    qttiming smallint,
    swimresultguid uuid,
    syncmodified integer,
    isdirty character(1) DEFAULT 'F'::bpchar,
    CONSTRAINT swimresult_bonusentry_check CHECK ((bonusentry = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT swimresult_dsqnotified_check CHECK ((dsqnotified = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT swimresult_finalfix_check CHECK ((finalfix = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT swimresult_isdirty_check CHECK ((isdirty = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT swimresult_lateentry_check CHECK ((lateentry = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT swimresult_noadvance_check CHECK ((noadvance = ANY (ARRAY['F'::bpchar, 'T'::bpchar])))
);

CREATE TABLE public.swimsession (
    swimsessionid integer NOT NULL,
    course smallint,
    daytime timestamp without time zone,
    endtime timestamp without time zone,
    feeathlete double precision,
    following character(1) DEFAULT 'F'::bpchar,
    lanemin smallint,
    lanemax smallint,
    lanesbyplace character varying(100),
    maxentriesathlete smallint,
    maxentriesrelay smallint,
    name character varying(100),
    officialmeeting timestamp without time zone,
    poolglobal character(1) DEFAULT 'F'::bpchar,
    pooltype smallint,
    remarks text,
    remarksjury text,
    roundtotenths character(1) DEFAULT 'F'::bpchar,
    sessionnumber smallint,
    startdate timestamp without time zone,
    timing smallint,
    tlmeeting timestamp without time zone,
    touchpadmode smallint,
    warmupfrom timestamp without time zone,
    warmupuntil timestamp without time zone,
    swimsessionguid uuid,
    syncmodified integer,
    isdirty character(1) DEFAULT 'F'::bpchar,
    CONSTRAINT swimsession_following_check CHECK ((following = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT swimsession_isdirty_check CHECK ((isdirty = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT swimsession_poolglobal_check CHECK ((poolglobal = ANY (ARRAY['F'::bpchar, 'T'::bpchar]))),
    CONSTRAINT swimsession_roundtotenths_check CHECK ((roundtotenths = ANY (ARRAY['F'::bpchar, 'T'::bpchar])))
);

CREATE TABLE public.swimstyle (
    swimstyleid integer NOT NULL,
    code character varying(10),
    distance smallint,
    name character varying(50),
    relaycount smallint,
    stroke smallint,
    sortcode integer,
    technique smallint,
    uniqueid smallint,
    swimstyleguid uuid,
    syncmodified integer,
    isdirty character(1) DEFAULT 'F'::bpchar,
    CONSTRAINT swimstyle_isdirty_check CHECK ((isdirty = ANY (ARRAY['F'::bpchar, 'T'::bpchar])))
);

CREATE TABLE public.syncdelete (
    syncdeleteid integer NOT NULL,
    tablename character varying(50),
    itemguid uuid
);

CREATE TABLE public.timestandard (
    timestandardlistid integer NOT NULL,
    swimstyleid integer NOT NULL,
    swimtime integer
);

CREATE TABLE public.timestandardlist (
    timestandardlistid integer NOT NULL,
    agemax smallint,
    agemin smallint,
    code character varying(5),
    course smallint,
    gender smallint,
    handicap smallint,
    name character varying(50),
    nation character varying(3),
    standardtype smallint,
    tslgroup integer
);

CREATE TABLE public.timingdata (
    timingdataid integer NOT NULL,
    datatype smallint,
    dnsbits character varying(3),
    eventnumber smallint,
    eventnumberex character varying(8),
    heatid smallint,
    heatnumber smallint,
    heatnumberex smallint,
    instancenumber smallint,
    lane smallint,
    lap smallint,
    modified timestamp without time zone,
    place smallint,
    swimsessionid integer,
    swimtime integer
);

ALTER TABLE ONLY public.bsmessage ALTER COLUMN bsmessageid SET DEFAULT nextval('public.bsmessage_bsmessageid_seq'::regclass);

ALTER TABLE ONLY public.bsmessage
    ADD CONSTRAINT bsmessage_pkey PRIMARY KEY (bsmessageid);

ALTER TABLE ONLY public.agegroup
    ADD CONSTRAINT pk_agegroup PRIMARY KEY (agegroupid);

ALTER TABLE ONLY public.athlete
    ADD CONSTRAINT pk_athlete PRIMARY KEY (athleteid);

ALTER TABLE ONLY public.biography
    ADD CONSTRAINT pk_biography PRIMARY KEY (biographyid);

ALTER TABLE ONLY public.bsglobal
    ADD CONSTRAINT pk_bsglobal PRIMARY KEY (name);

ALTER TABLE ONLY public.bspicture
    ADD CONSTRAINT pk_bspicture PRIMARY KEY (bspictureid);

ALTER TABLE ONLY public.bsswkatalogitem
    ADD CONSTRAINT pk_bsswkatalogitem PRIMARY KEY (bsswkatalogitemid);

ALTER TABLE ONLY public.club
    ADD CONSTRAINT pk_club PRIMARY KEY (clubid);

ALTER TABLE ONLY public.coach
    ADD CONSTRAINT pk_coach PRIMARY KEY (coachid);

ALTER TABLE ONLY public.dsqitem
    ADD CONSTRAINT pk_dsqitem PRIMARY KEY (dsqitemid);

ALTER TABLE ONLY public.eventrecord
    ADD CONSTRAINT pk_eventrecord PRIMARY KEY (eventrecordid);

ALTER TABLE ONLY public.heat
    ADD CONSTRAINT pk_heat PRIMARY KEY (heatid);

ALTER TABLE ONLY public.judge
    ADD CONSTRAINT pk_judge PRIMARY KEY (judgeid);

ALTER TABLE ONLY public.official
    ADD CONSTRAINT pk_official PRIMARY KEY (officialid);

ALTER TABLE ONLY public.record
    ADD CONSTRAINT pk_record PRIMARY KEY (recordid);

ALTER TABLE ONLY public.recordagegroup
    ADD CONSTRAINT pk_recordagegroup PRIMARY KEY (recordagegroupid);

ALTER TABLE ONLY public.recordlist
    ADD CONSTRAINT pk_recordlist PRIMARY KEY (recordlistid);

ALTER TABLE ONLY public.recordsplit
    ADD CONSTRAINT pk_recordsplit PRIMARY KEY (recordid, distance);

ALTER TABLE ONLY public.relay
    ADD CONSTRAINT pk_relay PRIMARY KEY (relayid);

ALTER TABLE ONLY public.relaysplit
    ADD CONSTRAINT pk_relaysplit PRIMARY KEY (relayid, distance);

ALTER TABLE ONLY public.resultplace
    ADD CONSTRAINT pk_resultplace PRIMARY KEY (agegroupid, sortcode);

ALTER TABLE ONLY public.splashmemessage
    ADD CONSTRAINT pk_splashmemessage PRIMARY KEY (splashmemessageid);

ALTER TABLE ONLY public.split
    ADD CONSTRAINT pk_split PRIMARY KEY (swimresultid, distance);

ALTER TABLE ONLY public.swimevent
    ADD CONSTRAINT pk_swimevent PRIMARY KEY (swimeventid);

ALTER TABLE ONLY public.swimresult
    ADD CONSTRAINT pk_swimresult PRIMARY KEY (swimresultid);

ALTER TABLE ONLY public.swimsession
    ADD CONSTRAINT pk_swimsession PRIMARY KEY (swimsessionid);

ALTER TABLE ONLY public.swimstyle
    ADD CONSTRAINT pk_swimstyle PRIMARY KEY (swimstyleid);

ALTER TABLE ONLY public.syncdelete
    ADD CONSTRAINT pk_syncdelete PRIMARY KEY (syncdeleteid);

ALTER TABLE ONLY public.timestandard
    ADD CONSTRAINT pk_timestandard PRIMARY KEY (timestandardlistid, swimstyleid);

ALTER TABLE ONLY public.timestandardlist
    ADD CONSTRAINT pk_timestandardlist PRIMARY KEY (timestandardlistid);

ALTER TABLE ONLY public.timingdata
    ADD CONSTRAINT pk_timingdata PRIMARY KEY (timingdataid);

CREATE INDEX ix_agegroup_swimevent ON public.agegroup USING btree (swimeventid);

CREATE INDEX ix_athlete_club ON public.athlete USING btree (clubid);

CREATE INDEX ix_athlete_firstname ON public.athlete USING btree (firstname_upper);

CREATE INDEX ix_athlete_lastname ON public.athlete USING btree (lastname_upper);

CREATE INDEX ix_bsswkatalogitem_katalog ON public.bsswkatalogitem USING btree (katalogid, itemid);

CREATE INDEX ix_eventrecord_swimevent ON public.eventrecord USING btree (swimeventid);

CREATE INDEX ix_heat_swimevent ON public.heat USING btree (swimeventid);

CREATE INDEX ix_judge_official ON public.judge USING btree (officialid);

CREATE INDEX ix_judge_swimsession ON public.judge USING btree (swimsessionid);

CREATE INDEX ix_official_club ON public.official USING btree (clubid);

CREATE INDEX ix_record_agegroup ON public.record USING btree (recordagegroupid);

CREATE INDEX ix_record_recordlist_swimstyle ON public.record USING btree (recordlistid, swimstyleid, course);

CREATE INDEX ix_record_swimstyle ON public.record USING btree (swimstyleid);

CREATE INDEX ix_recordposition_record ON public.recordposition USING btree (recordid);

CREATE INDEX ix_relay_club ON public.relay USING btree (clubid);

CREATE INDEX ix_relay_swimevent ON public.relay USING btree (swimeventid);

CREATE INDEX ix_relayposition_athlete ON public.relayposition USING btree (athleteid);

CREATE INDEX ix_relayposition_relay ON public.relayposition USING btree (relayid);

CREATE INDEX ix_rlagegroup_agegroup ON public.recordlistagegroup USING btree (recordagegroupid);

CREATE INDEX ix_rlagegroup_recordlist ON public.recordlistagegroup USING btree (recordlistid);

CREATE INDEX ix_splashmemessage_modified ON public.splashmemessage USING btree (modified DESC);

CREATE INDEX ix_splashmemessage_swrid ON public.splashmemessage USING btree (swrid);

CREATE INDEX ix_swimevent_swimsession ON public.swimevent USING btree (swimsessionid);

CREATE INDEX ix_swimevent_swimstyle ON public.swimevent USING btree (swimstyleid);

CREATE INDEX ix_swimresult_athlete ON public.swimresult USING btree (athleteid);

CREATE INDEX ix_swimresult_swimevent ON public.swimresult USING btree (swimeventid);

CREATE INDEX ix_timestandard_swimstyle ON public.timestandard USING btree (swimstyleid);

CREATE INDEX ix_timingdata_swimsession ON public.timingdata USING btree (swimsessionid);

ALTER TABLE ONLY public.agegroup
    ADD CONSTRAINT fk_agegroup_swimevent FOREIGN KEY (swimeventid) REFERENCES public.swimevent(swimeventid) ON DELETE CASCADE;

ALTER TABLE ONLY public.athlete
    ADD CONSTRAINT fk_athlete_club FOREIGN KEY (clubid) REFERENCES public.club(clubid);

ALTER TABLE ONLY public.eventrecord
    ADD CONSTRAINT fk_eventrecord_swimevent FOREIGN KEY (swimeventid) REFERENCES public.swimevent(swimeventid) ON DELETE CASCADE;

ALTER TABLE ONLY public.heat
    ADD CONSTRAINT fk_heat_swimevent FOREIGN KEY (swimeventid) REFERENCES public.swimevent(swimeventid) ON DELETE CASCADE;

ALTER TABLE ONLY public.judge
    ADD CONSTRAINT fk_judge_official FOREIGN KEY (officialid) REFERENCES public.official(officialid);

ALTER TABLE ONLY public.judge
    ADD CONSTRAINT fk_judge_swimsession FOREIGN KEY (swimsessionid) REFERENCES public.swimsession(swimsessionid) ON DELETE CASCADE;

ALTER TABLE ONLY public.official
    ADD CONSTRAINT fk_official_club FOREIGN KEY (clubid) REFERENCES public.club(clubid);

ALTER TABLE ONLY public.record
    ADD CONSTRAINT fk_record_agegroup FOREIGN KEY (recordagegroupid) REFERENCES public.recordagegroup(recordagegroupid) ON DELETE CASCADE;

ALTER TABLE ONLY public.record
    ADD CONSTRAINT fk_record_recordlist FOREIGN KEY (recordlistid) REFERENCES public.recordlist(recordlistid) ON DELETE CASCADE;

ALTER TABLE ONLY public.record
    ADD CONSTRAINT fk_record_swimstyle FOREIGN KEY (swimstyleid) REFERENCES public.swimstyle(swimstyleid);

ALTER TABLE ONLY public.recordposition
    ADD CONSTRAINT fk_recordposition_record FOREIGN KEY (recordid) REFERENCES public.record(recordid) ON DELETE CASCADE;

ALTER TABLE ONLY public.recordsplit
    ADD CONSTRAINT fk_recordsplit_record FOREIGN KEY (recordid) REFERENCES public.record(recordid) ON DELETE CASCADE;

ALTER TABLE ONLY public.relay
    ADD CONSTRAINT fk_relay_club FOREIGN KEY (clubid) REFERENCES public.club(clubid);

ALTER TABLE ONLY public.relay
    ADD CONSTRAINT fk_relay_swimevent FOREIGN KEY (swimeventid) REFERENCES public.swimevent(swimeventid) ON DELETE CASCADE;

ALTER TABLE ONLY public.relayposition
    ADD CONSTRAINT fk_relayposition_athlete FOREIGN KEY (athleteid) REFERENCES public.athlete(athleteid);

ALTER TABLE ONLY public.relayposition
    ADD CONSTRAINT fk_relayposition_relay FOREIGN KEY (relayid) REFERENCES public.relay(relayid) ON DELETE CASCADE;

ALTER TABLE ONLY public.relaysplit
    ADD CONSTRAINT fk_relaysplit_relay FOREIGN KEY (relayid) REFERENCES public.relay(relayid) ON DELETE CASCADE;

ALTER TABLE ONLY public.resultplace
    ADD CONSTRAINT fk_resultplace_agegroup FOREIGN KEY (agegroupid) REFERENCES public.agegroup(agegroupid) ON DELETE CASCADE;

ALTER TABLE ONLY public.recordlistagegroup
    ADD CONSTRAINT fk_rlagegroup_agegroup FOREIGN KEY (recordagegroupid) REFERENCES public.recordagegroup(recordagegroupid) ON DELETE CASCADE;

ALTER TABLE ONLY public.recordlistagegroup
    ADD CONSTRAINT fk_rlagegroup_recordlist FOREIGN KEY (recordlistid) REFERENCES public.recordlist(recordlistid) ON DELETE CASCADE;

ALTER TABLE ONLY public.split
    ADD CONSTRAINT fk_split_swimresult FOREIGN KEY (swimresultid) REFERENCES public.swimresult(swimresultid) ON DELETE CASCADE;

ALTER TABLE ONLY public.swimevent
    ADD CONSTRAINT fk_swimevent_swimsession FOREIGN KEY (swimsessionid) REFERENCES public.swimsession(swimsessionid) ON DELETE CASCADE;

ALTER TABLE ONLY public.swimevent
    ADD CONSTRAINT fk_swimevent_swimstyle FOREIGN KEY (swimstyleid) REFERENCES public.swimstyle(swimstyleid);

ALTER TABLE ONLY public.swimresult
    ADD CONSTRAINT fk_swimresult_athlete FOREIGN KEY (athleteid) REFERENCES public.athlete(athleteid) ON DELETE CASCADE;

ALTER TABLE ONLY public.swimresult
    ADD CONSTRAINT fk_swimresult_swimevent FOREIGN KEY (swimeventid) REFERENCES public.swimevent(swimeventid) ON DELETE CASCADE;

ALTER TABLE ONLY public.timestandard
    ADD CONSTRAINT fk_timestandard_list FOREIGN KEY (timestandardlistid) REFERENCES public.timestandardlist(timestandardlistid) ON DELETE CASCADE;

ALTER TABLE ONLY public.timestandard
    ADD CONSTRAINT fk_timestandard_swimstyle FOREIGN KEY (swimstyleid) REFERENCES public.swimstyle(swimstyleid);

ALTER TABLE ONLY public.timingdata
    ADD CONSTRAINT fk_timingdata_swimsession FOREIGN KEY (swimsessionid) REFERENCES public.swimsession(swimsessionid) ON DELETE CASCADE;
