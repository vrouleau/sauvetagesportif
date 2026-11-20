-- Rows Splash Meet Manager writes into a database it creates (bsglobal keys, its swimstyle catalog, recordagegroup, sequence positions)
-- Captured with pg_dump from an empty database created by real Splash Meet Manager 11
-- (build 11.85709, 2026-11-20). meet-app runs this when it connects to a Postgres database that
-- has no tables yet, so the database is the same as one Splash created itself (exact types,
-- defaults, keys, indexes, sequences) and Splash can open it. Regenerate from a fresh database
-- Splash has connected to, after a Splash upgrade (see packages/meet-app/CLAUDE.md).
-- Multi-line values keep Splash's CRLF line breaks - keep this file's bytes as they are.

INSERT INTO public.swimstyle VALUES (1001, NULL, 25, NULL, 1, 1, 1, NULL, 47, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1002, NULL, 50, NULL, 1, 1, 2, NULL, 1, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1003, NULL, 100, NULL, 1, 1, 3, NULL, 2, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1004, NULL, 200, NULL, 1, 1, 4, NULL, 3, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1005, NULL, 300, NULL, 1, 1, 5, NULL, 4, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1006, NULL, 400, NULL, 1, 1, 6, NULL, 5, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1007, NULL, 500, NULL, 1, 1, 7, NULL, 55, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1008, NULL, 800, NULL, 1, 1, 8, NULL, 6, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1009, NULL, 1000, NULL, 1, 1, 9, NULL, 7, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1010, NULL, 1500, NULL, 1, 1, 10, NULL, 8, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1011, NULL, 1650, NULL, 1, 1, 11, NULL, 56, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1012, NULL, 3000, NULL, 1, 1, 12, NULL, 67, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1013, NULL, 5000, NULL, 1, 1, 13, NULL, 68, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1014, NULL, 10000, NULL, 1, 1, 14, NULL, 69, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1015, NULL, 25000, NULL, 1, 1, 15, NULL, 70, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1016, NULL, 25, NULL, 1, 2, 16, NULL, 48, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1017, NULL, 50, NULL, 1, 2, 17, NULL, 9, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1018, NULL, 100, NULL, 1, 2, 18, NULL, 10, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1019, NULL, 200, NULL, 1, 2, 19, NULL, 11, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1020, NULL, 25, NULL, 1, 3, 20, NULL, 49, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1021, NULL, 50, NULL, 1, 3, 21, NULL, 12, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1022, NULL, 100, NULL, 1, 3, 22, NULL, 13, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1023, NULL, 200, NULL, 1, 3, 23, NULL, 14, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1024, NULL, 25, NULL, 1, 4, 24, NULL, 50, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1025, NULL, 50, NULL, 1, 4, 25, NULL, 15, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1026, NULL, 100, NULL, 1, 4, 26, NULL, 16, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1027, NULL, 200, NULL, 1, 4, 27, NULL, 17, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1028, NULL, 75, NULL, 1, 5, 28, NULL, 79, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1029, NULL, 100, NULL, 1, 5, 29, NULL, 20, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1030, NULL, 150, NULL, 1, 5, 30, NULL, 76, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1031, NULL, 200, NULL, 1, 5, 31, NULL, 18, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1032, NULL, 400, NULL, 1, 5, 32, NULL, 19, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1033, NULL, 25, NULL, 4, 1, 33, NULL, 86, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1034, NULL, 50, NULL, 4, 1, 34, NULL, 24, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1035, NULL, 100, NULL, 4, 1, 35, NULL, 27, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1036, NULL, 200, NULL, 4, 1, 36, NULL, 29, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1037, NULL, 50, NULL, 5, 1, 37, NULL, 25, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1038, NULL, 25, NULL, 8, 1, 38, NULL, 51, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1039, NULL, 50, NULL, 8, 1, 39, NULL, 53, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1040, NULL, 50, NULL, 10, 1, 40, NULL, 26, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1041, NULL, 100, NULL, 10, 1, 41, NULL, 28, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1042, NULL, 25, NULL, 4, 2, 42, NULL, 93, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1043, NULL, 50, NULL, 4, 2, 43, NULL, 30, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1044, NULL, 100, NULL, 4, 2, 44, NULL, 31, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1045, NULL, 200, NULL, 4, 2, 45, NULL, 32, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1046, NULL, 25, NULL, 4, 3, 46, NULL, 94, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1047, NULL, 50, NULL, 4, 3, 47, NULL, 33, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1048, NULL, 100, NULL, 4, 3, 48, NULL, 34, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1049, NULL, 200, NULL, 4, 3, 49, NULL, 35, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1050, NULL, 25, NULL, 4, 4, 50, NULL, 92, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1051, NULL, 50, NULL, 4, 4, 51, NULL, 36, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1052, NULL, 100, NULL, 4, 4, 52, NULL, 37, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1053, NULL, 200, NULL, 4, 4, 53, NULL, 38, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1054, NULL, 25, NULL, 4, 5, 54, NULL, 87, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1055, NULL, 50, NULL, 4, 5, 55, NULL, 39, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1056, NULL, 100, NULL, 4, 5, 56, NULL, 40, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1057, NULL, 25, NULL, 8, 5, 57, NULL, 52, gen_random_uuid(), NULL, 'F');
INSERT INTO public.swimstyle VALUES (1058, NULL, 50, NULL, 8, 5, 58, NULL, 54, gen_random_uuid(), NULL, 'F');

INSERT INTO public.bsglobal VALUES ('BSAPPLICATION', 'Meet Manager - MEET');
INSERT INTO public.bsglobal VALUES ('DB_DDL_VERSION_BASE', '20260801');
INSERT INTO public.bsglobal VALUES ('BSDB_DDL_VERSION_APPLICATION', '20260901');
INSERT INTO public.bsglobal VALUES ('AgegroupHeatCountSet', 'T');
INSERT INTO public.bsglobal VALUES ('BSDB_DDL_VERSION_SW_KATALOG', '01.00');
INSERT INTO public.bsglobal VALUES ('BSDB_DDL_VERSION_PICTURE', '01.01');
INSERT INTO public.bsglobal VALUES ('REPORTDEFINITION', '<?xml version="1.0" encoding="UTF-16"?>
<REPORTDEFINITION>
  <LAYOUTS>
    <LAYOUT layoutid="10" type="STARTLIST" name="Start list (4 columns)" fontsize="60" legendsize="50" splitofs="30" listcols="4">
      <COLUMNS>
        <COLUMN type="LANE" width="15" />
        <COLUMN type="EMPTY" width="5" />
        <COLUMN type="FULLNAME" width="135" />
        <COLUMN type="AGEINFO" width="20" />
        <COLUMN type="CLUBCODE" width="60" />
      </COLUMNS>
    </LAYOUT>
    <LAYOUT layoutid="5" type="RESULTHTML" name="Format standard" fontsize="40" legendsize="30" splitofs="8">
      <COLUMNS>
        <COLUMN type="PLACE" width="6" />
        <COLUMN type="EMPTY" width="2" />
        <COLUMN type="FULLNAME" width="30" />
        <COLUMN type="AGEINFO" width="5" />
        <COLUMN type="CLUBSHORTNAME" width="20" />
        <COLUMN type="SWIMTIME" width="10" />
        <COLUMN type="POINTS" width="6" />
        <COLUMN type="EMPTY" width="2" />
        <COLUMN type="MIXEDCODES" width="5" />
      </COLUMNS>
    </LAYOUT>
    <LAYOUT layoutid="1" type="RESULTNOSPLIT" name="Format standard" fontsize="100" legendsize="80" splitofs="65">
      <COLUMNS>
        <COLUMN type="PLACE" width="50" />
        <COLUMN type="EMPTY" width="15" />
        <COLUMN type="FULLNAME" width="340" />
        <COLUMN type="AGEINFO" width="50" />
        <COLUMN type="CLUBSHORTNAME" width="310" />
        <COLUMN type="SWIMTIME" width="100" />
        <COLUMN type="POINTS" width="60" />
        <COLUMN type="EMPTY" width="15" />
        <COLUMN type="MIXEDCODES" width="60" />
      </COLUMNS>
    </LAYOUT>
    <LAYOUT layoutid="18" type="ENTRYBYATHLETE" name="Swim style, heat/lane (2 columns)" fontsize="90" legendsize="70" listcols="2">
      <COLUMNS>
        <COLUMN type="FULLNAME" width="160" />
        <COLUMN type="AGEINFO" width="30" />
        <COLUMN type="CLUBCODE" width="70" />
        <COLUMN type="LICENSE" width="60" />
        <COLUMN type="EVENTNUMBER" width="60" />
        <COLUMN type="SWIMSTYLECODE" width="90" />
        <COLUMN type="ENTRYTIMESTATUS" width="90" />
        <COLUMN type="EMPTY" width="20" />
        <COLUMN type="HEATLANE" width="60" />
      </COLUMNS>
    </LAYOUT>
    <LAYOUT layoutid="13" type="ENTRYLIST" name="Entry list (3 columns)" fontsize="80" legendsize="80" splitofs="60" listcols="3">
      <COLUMNS>
        <COLUMN type="EMPTY" width="5" />
        <COLUMN type="PLACE" width="20" legende="." />
        <COLUMN type="EMPTY" width="5" />
        <COLUMN type="FULLNAME" width="180" />
        <COLUMN type="CLUBCODE" width="50" />
        <COLUMN type="ENTRYTIME" width="60" />
      </COLUMNS>
    </LAYOUT>
    <LAYOUT layoutid="9" type="STARTLIST" name="Start list (3 columns)" fontsize="70" legendsize="50" splitofs="40" listcols="3">
      <COLUMNS>
        <COLUMN type="LANE" width="20" />
        <COLUMN type="EMPTY" width="10" />
        <COLUMN type="FULLNAME" width="200" />
        <COLUMN type="AGEINFO" width="20" />
        <COLUMN type="CLUBCODE" width="70" />
      </COLUMNS>
    </LAYOUT>
    <LAYOUT layoutid="4" type="RESULT2COLUMN" name="Format standard" fontsize="90" legendsize="80">
      <COLUMNS>
        <COLUMN type="PLACE" width="40" />
        <COLUMN type="EMPTY" width="10" />
        <COLUMN type="FULLNAME" width="220" />
        <COLUMN type="AGEINFO" width="40" />
        <COLUMN type="CLUBCODE" width="70" />
        <COLUMN type="SWIMTIME" width="80" />
        <COLUMN type="EMPTY" width="5" />
        <COLUMN type="QUALCODE" width="20" />
      </COLUMNS>
    </LAYOUT>
    <LAYOUT layoutid="17" type="ENTRYBYATHLETE" name="Swim style, heat/lane, empty field (1 column)" fontsize="90" legendsize="70" listcols="1">
      <COLUMNS>
        <COLUMN type="FULLNAME" width="240" />
        <COLUMN type="GENDER" width="30" />
        <COLUMN type="LEVEL" width="30" />
        <COLUMN type="LICENSE" width="110" />
        <COLUMN type="SWIMSTYLEEVENT" width="240" />
        <COLUMN type="HEATLANE" width="60" />
        <COLUMN type="ENTRYTIME" width="120" />
        <COLUMN type="EMPTY" width="20" />
        <COLUMN type="EMPTYFIELD" width="130" />
      </COLUMNS>
    </LAYOUT>
    <LAYOUT layoutid="12" type="ENTRYLIST" name="Entry list (2 columns)" fontsize="80" legendsize="80" splitofs="60" listcols="2">
      <COLUMNS>
        <COLUMN type="EMPTY" width="10" />
        <COLUMN type="PLACE" width="20" legende="." />
        <COLUMN type="EMPTY" width="10" />
        <COLUMN type="FULLNAME" width="230" />
        <COLUMN type="AGEINFO" width="40" />
        <COLUMN type="CLUBCODE" width="70" />
        <COLUMN type="ENTRYTIME" width="100" />
        <COLUMN type="EMPTY" width="10" />
      </COLUMNS>
    </LAYOUT>
    <LAYOUT layoutid="8" type="STARTLIST" name="Start list (2 columns, empty time field)" fontsize="80" legendsize="80" splitofs="60" listcols="2">
      <COLUMNS>
        <COLUMN type="EMPTY" width="10" />
        <COLUMN type="LANE" width="20" />
        <COLUMN type="EMPTY" width="10" />
        <COLUMN type="FULLNAME" width="230" />
        <COLUMN type="AGEINFO" width="40" />
        <COLUMN type="CLUBCODE" width="70" />
        <COLUMN type="EMPTYTIMEFIELD" width="100" />
        <COLUMN type="EMPTY" width="10" />
      </COLUMNS>
    </LAYOUT>
    <LAYOUT layoutid="7" type="STARTLIST" name="Start list (2 columns)" fontsize="80" legendsize="80" splitofs="60" listcols="2">
      <COLUMNS>
        <COLUMN type="EMPTY" width="10" />
        <COLUMN type="LANE" width="20" />
        <COLUMN type="EMPTY" width="10" />
        <COLUMN type="FULLNAME" width="230" />
        <COLUMN type="AGEINFO" width="40" />
        <COLUMN type="CLUBCODE" width="70" />
        <COLUMN type="ENTRYTIME" width="100" />
        <COLUMN type="EMPTY" width="10" />
      </COLUMNS>
    </LAYOUT>
    <LAYOUT layoutid="16" type="ENTRYBYATHLETE" name="Swim style (4 columns)" fontsize="80" legendsize="70" listcols="4">
      <COLUMNS>
        <COLUMN type="FULLNAME" width="160" />
        <COLUMN type="AGEINFO" width="30" />
        <COLUMN type="CLUBCODE" width="70" />
        <COLUMN type="LICENSE" width="60" />
        <COLUMN type="SWIMSTYLECODE" width="80" />
        <COLUMN type="ENTRYTIMESTATUS" width="70" />
      </COLUMNS>
    </LAYOUT>
    <LAYOUT layoutid="3" type="RESULT4SPLIT" name="Format standard" fontsize="90" legendsize="80" splitwidth="80" splitofs="50">
      <COLUMNS>
        <COLUMN type="PLACE" width="40" />
        <COLUMN type="EMPTY" width="10" />
        <COLUMN type="FULLNAME" width="210" />
        <COLUMN type="AGEINFO" width="50" />
        <COLUMN type="CLUBSHORTNAME" width="200" />
        <COLUMN type="SWIMTIME" width="80" />
        <COLUMN type="POINTS" width="40" />
        <COLUMN type="EMPTY" width="10" />
        <COLUMN type="MIXEDCODES" width="40" />
      </COLUMNS>
    </LAYOUT>
    <LAYOUT layoutid="15" type="ENTRYBYATHLETE" name="With proof of entry time (1 column)" fontsize="90" legendsize="70" listcols="1">
      <COLUMNS>
        <COLUMN type="FULLNAME" width="200" />
        <COLUMN type="AGEINFO" width="40" />
        <COLUMN type="CLUBCODE" width="90" />
        <COLUMN type="LICENSE" width="70" />
        <COLUMN type="SWIMSTYLEEVENT" width="210" />
        <COLUMN type="ENTRYTIMESTATUS" width="90" />
        <COLUMN type="ENTRYQTDATE" width="110" />
        <COLUMN type="EMPTY" width="10" />
        <COLUMN type="ENTRYQTCITY" width="160" />
      </COLUMNS>
    </LAYOUT>
    <LAYOUT layoutid="11" type="ENTRYLIST" name="Entry list (1 column)" fontsize="100" legendsize="80" splitofs="70" listcols="1">
      <COLUMNS>
        <COLUMN type="EMPTY" width="10" />
        <COLUMN type="PLACE" width="30" legende="." />
        <COLUMN type="EMPTY" width="10" />
        <COLUMN type="FULLNAME" width="340" />
        <COLUMN type="AGEINFO" width="50" />
        <COLUMN type="CLUBNAME" width="350" />
        <COLUMN type="ENTRYTIME" width="200" />
        <COLUMN type="EMPTY" width="10" />
      </COLUMNS>
    </LAYOUT>
    <LAYOUT layoutid="6" type="STARTLIST" name="Start list (1 column)" fontsize="100" legendsize="80" splitofs="70" listcols="1">
      <COLUMNS>
        <COLUMN type="EMPTY" width="10" />
        <COLUMN type="LANE" width="30" />
        <COLUMN type="EMPTY" width="10" />
        <COLUMN type="FULLNAME" width="340" />
        <COLUMN type="AGEINFO" width="50" />
        <COLUMN type="CLUBSHORTNAME" width="350" />
        <COLUMN type="ENTRYTIME" width="200" />
        <COLUMN type="EMPTY" width="10" />
      </COLUMNS>
    </LAYOUT>
    <LAYOUT layoutid="2" type="RESULT2SPLIT" name="Format standard" fontsize="90" legendsize="80" splitwidth="90" splitofs="55">
      <COLUMNS>
        <COLUMN type="PLACE" width="40" />
        <COLUMN type="EMPTY" width="15" />
        <COLUMN type="FULLNAME" width="250" />
        <COLUMN type="AGEINFO" width="50" />
        <COLUMN type="CLUBSHORTNAME" width="260" />
        <COLUMN type="SWIMTIME" width="90" />
        <COLUMN type="POINTS" width="50" />
        <COLUMN type="EMPTY" width="15" />
        <COLUMN type="MIXEDCODES" width="50" />
      </COLUMNS>
    </LAYOUT>
    <LAYOUT layoutid="14" type="ENTRYBYATHLETE" name="Swim style (2 columns)" fontsize="90" legendsize="70" listcols="2">
      <COLUMNS>
        <COLUMN type="FULLNAME" width="200" />
        <COLUMN type="AGEINFO" width="40" />
        <COLUMN type="CLUBCODE" width="90" />
        <COLUMN type="LICENSE" width="70" />
        <COLUMN type="SWIMSTYLEEVENT" width="200" />
        <COLUMN type="ENTRYTIMESTATUS" width="80" />
      </COLUMNS>
    </LAYOUT>
  </LAYOUTS>
</REPORTDEFINITION>
');
INSERT INTO public.bsglobal VALUES ('GeneralSettings', 'RESULTPOINTMIN=I;1
RESULTPOINTMAX=I;1200
');
INSERT INTO public.bsglobal VALUES ('GUISettings', 'LiveResultsUsed=F
ME.TrvAthlete.IsCustom=F
ModulResultLastSession=0
ModulResultLastEvent=0
ModulResultLastHeat=0
MR.TrvResult.IsCustom=F
TimingMasterIndex=-1
TimingDlgCount=0
ActiveModul=Event
BaseFile=default.mdb
SplashMeMessageIdNext=1
');

INSERT INTO public.recordagegroup VALUES (0, -1, -1, 0);

SELECT pg_catalog.setval('public.bsmessage_bsmessageid_seq', 1, false);

SELECT pg_catalog.setval('public.gen_bs_global_uid', 1058, true);

SELECT pg_catalog.setval('public.gen_layout', 18, true);
